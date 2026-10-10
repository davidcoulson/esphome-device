// Seeded fuzzing of everything that parses bytes from the network: the protobuf decoder, both
// framers, the mDNS parser and responder, and a live Device sprayed with junk. Every target must
// either return or throw an Error, quickly, without buffering more than its limit, and the Device
// must still serve a real client afterwards. Failures print the seed; replay with FUZZ_SEED.
// FUZZ_ITERATIONS raises the count for a deeper local run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { encode, decode } from '../src/proto.mjs';
import { messages, byName } from '../src/messages.mjs';
import { PlaintextFramer, NoiseFramer, MAX_MESSAGE_SIZE, MAX_HANDSHAKE_SIZE } from '../src/frame.mjs';
import { NoiseInitiator } from '../src/noise.mjs';
import { parseMessage, Advertiser, writeName } from '../src/mdns.mjs';
import { Device } from '../src/index.mjs';

const N = Number(process.env.FUZZ_ITERATIONS || 3000);
const SEED = Number(process.env.FUZZ_SEED || Date.now() % 2 ** 31);

// mulberry32: small, fast, and the same sequence for the same seed everywhere.
function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
  const int = (n) => Math.floor(next() * n);
  const bytes = (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = int(256); return b; };
  // Flip, insert, delete, overwrite with an interesting value, or splice: the usual mutators.
  const mutate = (buf) => {
    const b = [...buf];
    for (let k = 1 + int(4); k > 0; k--) {
      const at = int(b.length + 1);
      switch (int(5)) {
        case 0: if (b.length) b[at % b.length] ^= 1 << int(8); break;
        case 1: b.splice(at, 0, ...bytes(1 + int(8))); break;
        case 2: b.splice(at, 1 + int(8)); break;
        case 3: if (b.length) b[at % b.length] = [0, 0x7f, 0x80, 0xff, 0xc0][int(5)]; break;
        default: b.splice(at, 0, ...b.slice(int(b.length + 1), int(b.length + 1)));
      }
    }
    return Buffer.from(b);
  };
  return { next, int, bytes, mutate, pick: (xs) => xs[int(xs.length)] };
}

const tagged = (name) => (err) => { err.message = `${err.message} [${name}, FUZZ_SEED=${SEED}]`; throw err; };
// Run fn; it may throw, but only an Error, and it must not take long.
function survives(fn, what) {
  const t = performance.now();
  try { fn(); } catch (err) { assert.ok(err instanceof Error, `${what} threw a non-Error: ${String(err)}`); }
  const ms = performance.now() - t;
  assert.ok(ms < 250, `${what} took ${ms.toFixed(0)} ms`);
}

// A random value for a field type, for round trips.
function value(r, type, depth = 0) {
  if (Array.isArray(type)) return Array.from({ length: r.int(3) }, () => obj(r, type[0], depth + 1));
  if (typeof type === 'object') return obj(r, type, depth + 1);
  if (type.endsWith('[]')) return Array.from({ length: r.int(4) }, () => value(r, type.slice(0, -2), depth));
  switch (type) {
    case 'string': return r.bytes(r.int(20)).toString('base64');
    case 'bytes': return r.bytes(r.int(20));
    case 'bool': return r.int(2) === 1;
    case 'uint32': case 'enum': case 'fixed32': return r.pick([0, 1, 127, 128, 0xffff, 0xffffffff, r.int(2 ** 32)]);
    case 'int32': case 'sint32': return r.pick([0, 1, -1, 2 ** 31 - 1, -(2 ** 31), r.int(2 ** 32) - 2 ** 31]);
    case 'float': return Math.fround((r.next() - 0.5) * 10 ** r.int(8));
    default: throw new Error(`no generator for ${type}`);
  }
}
const obj = (r, schema, depth = 0) => (depth > 3 ? {} : Object.fromEntries(Object.entries(schema.fields).filter(() => r.int(3) > 0).map(([k, [, t]]) => [k, value(r, t, depth)])));
// What decode() gives back for an object: proto3 drops defaults and decode fills them in.
function expected(schema, o) {
  const full = decode(schema, Buffer.alloc(0));
  for (const [k, [, t]] of Object.entries(schema.fields)) {
    if (o[k] === undefined) continue;
    if (Array.isArray(t)) full[k] = o[k].map((x) => expected(t[0], x));
    else if (typeof t === 'object') full[k] = expected(t, o[k]);
    else full[k] = t === 'bytes' ? Buffer.from(o[k]) : o[k];
  }
  return full;
}

test(`fuzz: protobuf round trips for every message (seed ${SEED})`, () => {
  const r = rng(SEED);
  try {
    for (let i = 0; i < N; i++) {
      const schema = r.pick(messages);
      const o = obj(r, schema);
      assert.deepEqual(decode(schema, encode(schema, o)), expected(schema, o), schema.name);
    }
  } catch (err) { tagged('round trip')(err); }
});

test(`fuzz: protobuf decode of random and mutated bytes (seed ${SEED})`, () => {
  const r = rng(SEED + 1);
  for (let i = 0; i < N; i++) {
    const schema = r.pick(messages);
    const input = r.int(2) ? r.bytes(r.int(64)) : r.mutate(encode(schema, obj(r, schema)));
    survives(() => decode(schema, input), `decode ${schema.name}`);
  }
});

test(`fuzz: plaintext framer, valid streams cut anywhere and junk (seed ${SEED})`, () => {
  const r = rng(SEED + 2);
  const limit = 4096;
  for (let i = 0; i < N; i++) {
    const frames = Array.from({ length: 1 + r.int(4) }, () => ({ type: r.int(0x10000), payload: r.bytes(r.int(300)) }));
    const stream = Buffer.concat(frames.map((f) => new PlaintextFramer().frame(f.type, f.payload)));
    const f = new PlaintextFramer({ maxMessageSize: limit });
    const got = [];
    for (let at = 0; at < stream.length;) { const n = 1 + r.int(40); got.push(...f.feed(stream.subarray(at, at + n))); at += n; }
    assert.deepEqual(got.map((m) => [m.type, m.payload.toString('hex')]), frames.map((m) => [m.type, m.payload.toString('hex')]), `seed ${SEED} case ${i}`);
    const junk = new PlaintextFramer({ maxMessageSize: limit });
    const bad = r.int(2) ? r.mutate(stream) : r.bytes(r.int(100));
    for (let at = 0; at < bad.length; at += 7) survives(() => junk.feed(bad.subarray(at, at + 7)), 'plaintext feed');
    assert.ok(junk.buffered <= limit + 11, `plaintext framer buffered ${junk.buffered} bytes`);
  }
});

test(`fuzz: noise framer in every state (seed ${SEED})`, () => {
  const r = rng(SEED + 3);
  const psk = Buffer.alloc(32, 7);
  for (let i = 0; i < N; i++) {
    const f = new NoiseFramer({ psk, name: 'fuzz', mac: '0a0b0c0d0e0f', maxMessageSize: 1024 });
    const state = r.int(3);
    let init;
    if (state >= 1) f.feed(Buffer.from([1, 0, 0]), () => {});
    if (state === 2) {
      init = new NoiseInitiator(psk, Buffer.from('NoiseAPIInit\0\0'));
      const m = init.writeMessage();
      const out = [];
      f.feed(Buffer.concat([Buffer.from([1, 0, m.length + 1, 0]), m]), (b) => out.push(b));
    }
    let input;
    if (state === 2) {
      // Past the handshake, mutating ciphertext only ever fails the MAC. To reach the parsing of a
      // decrypted record, encrypt random plaintext (a type and length header that may lie) properly.
      const send = init.split().send;
      const records = Array.from({ length: 1 + r.int(3) }, () => {
        const plain = r.int(2) ? r.bytes(r.int(40)) : Buffer.concat([Buffer.from([r.int(256), r.int(256), r.int(256), r.int(256)]), r.bytes(r.int(40))]);
        const ct = send.encrypt(Buffer.alloc(0), plain);
        return Buffer.concat([Buffer.from([1, ct.length >> 8, ct.length & 255]), ct]);
      });
      input = Buffer.concat(r.int(4) ? records : [r.mutate(Buffer.concat(records))]);
    } else {
      const valid = Buffer.concat([Buffer.from([1, 0, 49, 0]), r.bytes(48)]);
      input = r.int(2) ? r.mutate(valid) : r.bytes(r.int(80));
    }
    for (let at = 0; at < input.length; at += 1 + r.int(16)) survives(() => f.feed(input.subarray(at, at + 16), () => {}), `noise feed state ${state}`);
    assert.ok(f.buffered <= Math.max(1024 + 20, MAX_HANDSHAKE_SIZE) + 3, `noise framer buffered ${f.buffered} bytes`);
  }
});

test(`fuzz: mDNS parser and responder (seed ${SEED})`, () => {
  const r = rng(SEED + 4);
  const dev = new Device({ name: 'fuzz-mdns', log: false, mdns: false, port: 6053 });
  const adv = new Advertiser(dev, { address: '127.0.0.1' });
  adv.socket = { send() {} };
  const valid = [
    adv.packet(adv.records()),
    Buffer.concat([Buffer.from([0, 1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0]), writeName('_esphomelib._tcp.local'), Buffer.from([0, 12, 0, 1]), Buffer.from([0xc0, 12]), Buffer.from([0, 255, 0x80, 1])]),
  ];
  for (let i = 0; i < N; i++) {
    const input = r.int(3) ? r.mutate(r.pick(valid)) : r.bytes(r.int(200));
    survives(() => parseMessage(input), 'parseMessage');
    // The responder must swallow anything: it runs in a socket callback with no try around it.
    assert.doesNotThrow(() => adv._onMessage(input, { address: r.pick(['127.0.0.1', '8.8.8.8']), port: r.pick([5353, 40000]) }), `_onMessage [FUZZ_SEED=${SEED}]`);
  }
});

test(`fuzz: a live device sprayed with junk keeps serving (seed ${SEED})`, { timeout: 60_000 }, async () => {
  const r = rng(SEED + 5);
  for (const noise of [false, true]) {
    const dev = await new Device({ name: 'fuzz-live', port: 0, mdns: false, log: false, noiseKey: noise ? Buffer.alloc(32, 3).toString('base64') : undefined }).start();
    try {
      const hello = new PlaintextFramer().frame(byName.HelloRequest.id, encode(byName.HelloRequest, { client_info: 'fuzz', api_version_major: 1, api_version_minor: 18 }));
      const seeds = [hello, Buffer.from([1, 0, 0]), Buffer.from([1, 0, 0, 1, 0, 49, 0, ...Array(48).fill(1)])];
      const sockets = Math.min(200, Math.max(40, N / 20));
      for (let i = 0; i < sockets; i++) {
        const s = net.connect(dev.port, '127.0.0.1');
        s.on('error', () => {});
        await once(s, 'connect');
        const input = r.int(3) ? r.mutate(r.pick(seeds)) : r.bytes(r.int(120));
        for (let at = 0; at < input.length; at += 1 + r.int(32)) s.write(input.subarray(at, at + 32));
        await new Promise((res) => setTimeout(res, r.int(3)));
        s.destroy();
      }
      await new Promise((res) => setTimeout(res, 300));
      assert.ok(dev.connections.size <= 1, `${dev.connections.size} connections left over`);
      // And a real client still gets an answer.
      if (!noise) {
        const s = net.connect(dev.port, '127.0.0.1');
        await once(s, 'connect');
        const reader = new PlaintextFramer();
        const got = [];
        s.on('data', (d) => got.push(...reader.feed(d)));
        s.write(hello);
        for (let i = 0; i < 40 && !got.length; i++) await new Promise((res) => setTimeout(res, 25));
        assert.equal(got[0]?.type, byName.HelloResponse.id, 'device still answers a hello');
        s.destroy();
      }
    } catch (err) { tagged(`live ${noise ? 'noise' : 'plaintext'}`)(err); } finally { await dev.stop(); }
  }
});
