import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, encodeVarint, decodeVarint } from '../src/proto.mjs';
import { byName } from '../src/messages.mjs';
import { NoiseResponder, NoiseInitiator, parsePsk } from '../src/noise.mjs';
import { PlaintextFramer, NoiseFramer } from '../src/frame.mjs';
import { fnv1a, objectIdFrom } from '../src/entities.mjs';
import { Device, macFromName } from '../src/device.mjs';
import { Advertiser } from '../src/mdns.mjs';

test('varint round trips', () => {
  for (const n of [0, 1, 127, 128, 300, 16383, 16384, 0xffffffff]) {
    const b = encodeVarint(n); assert.deepEqual(decodeVarint(b, 0), [n, b.length]);
  }
  assert.equal(decodeVarint(Buffer.from([0x80]), 0), null);
});

test('protobuf: every wire type the API uses, defaults omitted, unknown fields skipped', () => {
  const s = byName.ListEntitiesSensorResponse;
  const obj = { object_id: 'temp', key: 0xfffffffe, name: 'Temp', unit_of_measurement: '°C', accuracy_decimals: 2, state_class: 1, force_update: false };
  const buf = encode(s, obj);
  const back = decode(s, buf);
  assert.equal(back.object_id, 'temp'); assert.equal(back.key, 0xfffffffe); assert.equal(back.unit_of_measurement, '°C');
  assert.equal(back.accuracy_decimals, 2); assert.equal(back.state_class, 1); assert.equal(back.icon, '');
  // A message with a field we don't know (tag 200, varint) decodes fine.
  const extra = Buffer.concat([buf, encodeVarint((200 << 3) | 0), encodeVarint(5)]);
  assert.equal(decode(s, extra).name, 'Temp');
  // negative int32 (ten-byte varint) and sint32 zigzag
  const a = byName.ExecuteServiceRequest;
  const d = decode(a, encode(a, { key: 1, args: [{ legacy_int: -3, int_: -7, float_: 1.5, int_array: [-1, 2] }] }));
  assert.equal(d.args[0].legacy_int, -3); assert.equal(d.args[0].int_, -7); assert.equal(d.args[0].float_, 1.5); assert.deepEqual(d.args[0].int_array, [-1, 2]);
});

test('noise: NNpsk0 handshake and transport keys agree; wrong psk fails the MAC', () => {
  const psk = Buffer.alloc(32, 1), prologue = Buffer.from('NoiseAPIInit\0\0');
  const i = new NoiseInitiator(psk, prologue), r = new NoiseResponder(psk, prologue);
  r.readMessage(i.writeMessage()); i.readMessage(r.writeMessage());
  const is = i.split(), rs = r.split();
  const ct = is.send.encrypt(Buffer.alloc(0), Buffer.from('ping'));
  assert.equal(rs.recv.decrypt(Buffer.alloc(0), ct).toString(), 'ping');
  const ct2 = rs.send.encrypt(Buffer.alloc(0), Buffer.from('pong'));
  assert.equal(is.recv.decrypt(Buffer.alloc(0), ct2).toString(), 'pong');
  assert.throws(() => is.recv.decrypt(Buffer.alloc(0), ct2), /Unsupported state|unable to authenticate|bad decrypt/i);   // replay: nonce moved on
  const bad = new NoiseResponder(Buffer.alloc(32, 2), prologue);
  assert.throws(() => bad.readMessage(new NoiseInitiator(psk, prologue).writeMessage()), (e) => e.code === 'MAC');
  assert.equal(parsePsk(psk.toString('base64')).length, 32);
  assert.throws(() => parsePsk('short'), /32 bytes/);
});

test('plaintext framer handles split and coalesced frames', () => {
  const f = new PlaintextFramer();
  const a = f.frame(1, Buffer.from('abc')), b = f.frame(300, Buffer.alloc(200, 7));
  const all = Buffer.concat([a, b]);
  const got = [];
  for (let i = 0; i < all.length; i += 5) got.push(...f.feed(all.subarray(i, i + 5)));
  assert.equal(got.length, 2); assert.equal(got[0].type, 1); assert.equal(got[0].payload.toString(), 'abc');
  assert.equal(got[1].type, 300); assert.equal(got[1].payload.length, 200);
  assert.throws(() => new PlaintextFramer().feed(Buffer.from([1, 0, 0])), /indicator/);
});

test('noise framer: hello, handshake, data frames both ways', () => {
  const psk = Buffer.alloc(32, 3);
  const server = new NoiseFramer({ psk, name: 'node-x', mac: '0a0b0c0d0e0f' });
  const sent = [];
  // client hello (empty)
  assert.deepEqual(server.feed(Buffer.from([1, 0, 0]), (b) => sent.push(b)), []);
  const hello = sent.shift();
  assert.equal(hello[0], 1); assert.equal(hello.subarray(3).toString('latin1'), '\x01node-x\0' + '0a0b0c0d0e0f\0');
  const init = new NoiseInitiator(psk, Buffer.from('NoiseAPIInit\0\0'));
  const m1 = init.writeMessage();
  const frame1 = Buffer.concat([Buffer.from([1, 0, m1.length + 1, 0]), m1]);
  assert.deepEqual(server.feed(frame1, (b) => sent.push(b)), []);
  const reply = sent.shift();
  assert.equal(reply[3], 0);
  init.readMessage(reply.subarray(4));
  const ck = init.split();
  assert.ok(server.ready);
  // client → server data
  const head = Buffer.from([0, 7, 0, 3]);  // type 7 (PingRequest), len 3
  const enc = ck.send.encrypt(Buffer.alloc(0), Buffer.concat([head, Buffer.from('xyz')]));
  const msgs = server.feed(Buffer.concat([Buffer.from([1, enc.length >> 8, enc.length & 255]), enc]));
  assert.equal(msgs.length, 1); assert.equal(msgs[0].type, 7); assert.equal(msgs[0].payload.toString(), 'xyz');
  // server → client
  const out = server.frame(8, Buffer.from('ok'));
  const plain = ck.recv.decrypt(Buffer.alloc(0), out.subarray(3));
  assert.equal(plain.readUInt16BE(0), 8); assert.equal(plain.subarray(4).toString(), 'ok');
  // reject text on bad handshake
  const s2 = new NoiseFramer({ psk, name: 'n', mac: '000000000000' });
  s2.feed(Buffer.from([1, 0, 0]), () => {});
  assert.throws(() => s2.feed(Buffer.from([1, 0, 2, 0, 9]), () => {}), (e) => e.reject === 'Handshake MAC failure');
});

test('entity ids and keys are stable and derived from names', () => {
  assert.equal(objectIdFrom('Cinema Mode!'), 'cinema_mode');
  assert.equal(fnv1a('cinema_mode'), fnv1a('cinema_mode'));
  assert.notEqual(fnv1a('a'), fnv1a('b'));
  assert.equal(macFromName('strimmer'), macFromName('strimmer'));
  assert.match(macFromName('strimmer'), /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/);
  assert.equal(parseInt(macFromName('strimmer').slice(0, 2), 16) & 0x03, 0x02);   // locally administered unicast
  const d = new Device({ name: 'Theater Panel', mdns: false, log: false });
  assert.equal(d.name, 'theater-panel');
  const sw = d.switch({ name: 'Cinema mode' });
  assert.equal(sw.objectId, 'cinema_mode');
  assert.throws(() => d.switch({ name: 'Cinema mode' }), /duplicate/);
});

test('start() listens without Home Assistant and stop() is clean', async () => {
  const d = new Device({ name: 'lonely', port: 0, mdns: false, log: false });
  await d.start(); assert.ok(d.port > 0);
  await d.stop(); await d.stop();
});

test('mDNS packets carry PTR, SRV, TXT and A with the keys HA reads', () => {
  const d = new Device({ name: 'strimmer', friendlyName: 'Strimmer', mdns: false, log: false, noiseKey: Buffer.alloc(32, 4).toString('base64'), project: { name: 'x.y', version: '1' } });
  const adv = new Advertiser(d, { address: '10.0.0.5' });
  const pkt = adv.packet(adv.records());
  assert.equal(pkt.readUInt16BE(2), 0x8400); assert.equal(pkt.readUInt16BE(6), 4);
  const txt = adv.txtRecords().toString('latin1');
  for (const k of ['version=', 'mac=', 'platform=', 'board=', 'network=', 'friendly_name=Strimmer', 'project_name=x.y', 'api_encryption=Noise_NNpsk0']) assert.ok(txt.includes(k), k);
  assert.ok(pkt.includes(Buffer.from([10, 0, 0, 5])));
});
