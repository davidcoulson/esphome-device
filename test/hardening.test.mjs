// The limits and edge cases from the Codex review: oversized and malformed frames, slow input,
// connection floods, clients that stop reading, DNS name and TXT limits, mDNS conflicts and
// reflection, server errors with no listener, and the log levels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { Device } from '../src/index.mjs';
import { FakeDevice } from '../src/testing.mjs';
import { PlaintextFramer, NoiseFramer, MAX_HANDSHAKE_SIZE } from '../src/frame.mjs';
import { encode, decode, encodeVarint } from '../src/proto.mjs';
import { byName } from '../src/messages.mjs';
import { Advertiser, writeName, txtStrings, parseMessage, isLocalSource } from '../src/mdns.mjs';

const quiet = { log: false, mdns: false, port: 0 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = new PlaintextFramer();
const frame = (name, obj = {}) => plain.frame(byName[name].id, encode(byName[name], obj));

// A raw plaintext client: connect, send frames, read the device's messages.
async function rawClient(port) {
  const sock = net.connect(port, '127.0.0.1');
  await once(sock, 'connect');
  const reader = new PlaintextFramer({ maxMessageSize: 1 << 20 });
  const got = [];
  sock.on('data', (d) => { for (const m of reader.feed(d)) got.push(m); });
  sock.on('error', () => {});
  const closed = new Promise((r) => sock.on('close', r));
  return { sock, got, closed, send: (buf) => sock.write(buf) };
}
const closedWithin = (p, ms) => Promise.race([p.then(() => true), wait(ms).then(() => false)]);

test('plaintext: an oversized length is refused at the header, before the body arrives', () => {
  const f = new PlaintextFramer({ maxMessageSize: 1000 });
  assert.throws(() => f.feed(Buffer.concat([Buffer.from([0]), encodeVarint(40000)])), /exceeds the 1000-byte limit/);
  assert.equal(new PlaintextFramer().buffered, 0);
});

test('plaintext: an overlong varint or an out-of-range type is refused', () => {
  assert.throws(() => new PlaintextFramer().feed(Buffer.from([0, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80])), /bad length varint/);
  assert.throws(() => new PlaintextFramer().feed(Buffer.concat([Buffer.from([0, 0]), encodeVarint(0x10000)])), /type 65536 out of range/);
  assert.throws(() => new PlaintextFramer().feed(Buffer.from([7])), /indicator/);
});

test('noise: handshake frames over 128 bytes and data frames over the limit are refused at the header', () => {
  const psk = Buffer.alloc(32, 1);
  const n = new NoiseFramer({ psk, name: 'n', mac: '000000000000' });
  const big = Buffer.from([1, 0, MAX_HANDSHAKE_SIZE + 1]);
  assert.throws(() => n.feed(big, () => {}), (e) => e.reject === 'Bad handshake packet len');
  const d = new NoiseFramer({ psk, name: 'n', mac: '000000000000', maxMessageSize: 100 });
  d.state = 'data';
  assert.throws(() => d.feed(Buffer.from([1, 0xff, 0xff])), /exceeds the 120-byte limit/);
});

test('protobuf: a truncated fixed64 field is an error, not a short message', () => {
  const s = byName.PingRequest;
  assert.throws(() => decode(s, Buffer.from([(9 << 3) | 1, 1, 2, 3])), /truncated fixed64/);
  assert.deepEqual(decode(s, Buffer.from([(9 << 3) | 1, 1, 2, 3, 4, 5, 6, 7, 8])), {});
});

test('connections past maxConnections are closed on accept', { timeout: 10_000 }, async () => {
  const dev = await new Device({ name: 'cap', ...quiet, maxConnections: 2 }).start();
  try {
    const a = await rawClient(dev.port), b = await rawClient(dev.port);
    const c = await rawClient(dev.port);
    assert.equal(await closedWithin(c.closed, 1000), true, 'third socket closed');
    assert.equal(dev.connections.size, 2);
    a.sock.destroy(); b.sock.destroy();
  } finally { await dev.stop(); }
});

test('a handshake that never finishes is dropped at the deadline, however much it trickles', { timeout: 10_000 }, async () => {
  const dev = await new Device({ name: 'slow', ...quiet, handshakeTimeoutMs: 400 }).start();
  try {
    const c = await rawClient(dev.port);
    const hello = frame('HelloRequest', { client_info: 'slow', api_version_major: 1, api_version_minor: 18 });
    let i = 0;
    const drip = setInterval(() => { if (i < hello.length - 1) c.send(hello.subarray(i, ++i)); }, 50);
    const started = Date.now();
    await c.closed;
    clearInterval(drip);
    assert.ok(Date.now() - started < 1500, 'closed near the deadline');
  } finally { await dev.stop(); }
});

test('after the hello, partial frames do not count as traffic', { timeout: 10_000 }, async () => {
  const dev = await new Device({ name: 'idle', ...quiet, pingIntervalMs: 100, idleTimeoutMs: 400 }).start();
  try {
    const c = await rawClient(dev.port);
    c.send(frame('HelloRequest', { client_info: 'idle', api_version_major: 1, api_version_minor: 18 }));
    await wait(100);
    assert.deepEqual(dev.clients[0].apiVersion, { major: 1, minor: 18 });
    c.send(Buffer.from([0, 0x10]));                       // a frame header that never completes
    const drip = setInterval(() => c.send(Buffer.from([0])), 50);
    const ok = await closedWithin(c.closed, 2000);
    clearInterval(drip);
    assert.equal(ok, true, 'dropped for lack of a complete message');
  } finally { await dev.stop(); }
});

test('a client that stops reading is dropped past maxWriteBuffer', { timeout: 15_000 }, async () => {
  const dev = new Device({ name: 'flood', ...quiet, maxWriteBuffer: 64 * 1024 });
  const text = dev.textSensor({ name: 'Blob' });
  await dev.start();
  try {
    const c = await rawClient(dev.port);
    c.send(frame('HelloRequest', { client_info: 'reader', api_version_major: 1, api_version_minor: 18 }));
    c.send(frame('SubscribeStatesRequest'));
    await wait(100);
    c.sock.pause();
    const chunk = 'x'.repeat(4000);
    for (let i = 0; i < 4000 && dev.connections.size; i++) { text.set(`${i}${chunk}`); if (i % 200 === 0) await wait(1); }
    for (let i = 0; i < 40 && dev.connections.size; i++) await wait(50);
    assert.equal(dev.connections.size, 0, 'connection dropped');
    c.sock.destroy();
  } finally { await dev.stop(); }
});

test('a server error after start is logged without a listener and delivered with one', async () => {
  const logged = [];
  const dev = await new Device({ name: 'err', mdns: false, port: 0, log: { info() {}, warn: (m) => logged.push(m) } }).start();
  try {
    assert.doesNotThrow(() => dev.server.emit('error', new Error('boom')));
    assert.ok(logged.some((m) => m.includes('server error: boom')));
    let got; dev.on('error', (e) => { got = e; });
    dev.server.emit('error', new Error('again'));
    assert.equal(got.message, 'again');
  } finally { await dev.stop(); }
});

test('log levels include very_verbose; unknown levels fall back to info', () => {
  const dev = new Device({ name: 'logs', ...quiet });
  const sent = [];
  dev.connections.add({ logLevel: 7, send: (name, obj) => sent.push(obj) });
  dev.log('very_verbose', 'deep'); dev.log('nonsense', 'plain'); dev.log('toString', 'proto');
  assert.equal(sent[0].level, 7); assert.match(sent[0].message.toString(), /\[VV\]/);
  assert.equal(sent[1].level, 3); assert.match(sent[1].message.toString(), /\[I\]/);
  assert.equal(sent[2].level, 3);
});

test('limits must be positive numbers', () => {
  assert.throws(() => new Device({ name: 'x', ...quiet, maxConnections: 0 }), /maxConnections must be a positive number/);
  assert.equal(new Device({ name: 'x', ...quiet, idleTimeoutMs: 5000 }).limits.idleTimeoutMs, 5000);
});

test('DNS names and TXT entries over their limits are refused at construction', () => {
  assert.throws(() => writeName(`${'a'.repeat(64)}.local`), /DNS allows 63/);
  assert.throws(() => writeName(Array(10).fill('a'.repeat(30)).join('.')), /DNS allows 255/);
  assert.throws(() => txtStrings({ k: 'v'.repeat(300) }), /TXT entry "k" is 302 bytes/);
  assert.throws(() => new Device({ name: 'n'.repeat(70), log: false }), /DNS allows 63/);
  assert.throws(() => new Device({ name: 'ok', log: false, friendlyName: 'f'.repeat(300) }), /TXT entry "friendly_name"/);
  assert.doesNotThrow(() => new Device({ name: 'n'.repeat(70), log: false, mdns: false }));
});

test('mDNS: another host claiming our name is a conflict; our own records are not', () => {
  const dev = new Device({ name: 'theater-panel', log: false, mdns: false, port: 6053 });
  const adv = new Advertiser(dev, { address: '10.0.0.5' });
  const ours = parseMessage(adv.packet(adv.records()));
  assert.equal(ours.response, true);
  assert.equal(adv.conflictIn(ours.records), null);
  const other = new Advertiser(new Device({ name: 'theater-panel', log: false, mdns: false, port: 7000 }), { address: '10.0.0.9' });
  const theirs = parseMessage(other.packet(other.records()));
  assert.equal(adv.conflictIn(theirs.records), 'theater-panel._esphomelib._tcp.local');
  const sameHost = parseMessage(other.packet(other.records().slice(3)));
  assert.equal(adv.conflictIn(sameHost.records), 'theater-panel.local');
});

test('mDNS: only queries from local networks are answered', () => {
  const nets = [[(10 << 24) >>> 0, 0xffff0000]];
  assert.equal(isLocalSource('10.0.4.7', nets), true);
  assert.equal(isLocalSource('8.8.8.8', nets), false);
  assert.equal(isLocalSource('fe80::1', nets), false);
  const dev = new Device({ name: 'reflect', log: false, mdns: false });
  const adv = new Advertiser(dev, { address: '10.0.0.5' });
  const sent = [];
  adv.socket = { send: (pkt, port, addr) => sent.push(addr) };
  const q = Buffer.concat([Buffer.from([0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), writeName('_esphomelib._tcp.local'), Buffer.from([0, 12, 0, 1])]);
  adv._onMessage(q, { address: '203.0.113.9', port: 40000 });
  assert.equal(sent.length, 0, 'off-net query ignored');
  adv._onMessage(q, { address: '127.0.0.1', port: 40000 });
  assert.deepEqual(sent, ['127.0.0.1'], 'local legacy query answered by unicast');
  const qu = Buffer.from(q); qu.writeUInt16BE(0x8001, qu.length - 2);   // QU bit set
  adv._onMessage(qu, { address: '127.0.0.1', port: 5353 });
  assert.equal(sent[1], '224.0.0.251', 'a port-5353 query is answered by multicast even when it asks for unicast');
});

test('mDNS: a newcomer yields while probing; an established device defends its name', () => {
  const mk = (port, address) => { const a = new Advertiser(new Device({ name: 'dup', log: false, mdns: false, port }), { address }); const sent = []; a.socket = { send: (p, port, addr) => sent.push(addr) }; a.sent = sent; return a; };
  const first = mk(6053, '10.0.0.5'), second = mk(6054, '10.0.0.6');
  const firstAnswer = first.packet(first.records());
  const events = [];
  second.device.on('mdns-conflict', (e) => events.push(e));
  second.probing = true;
  second._onMessage(firstAnswer, { address: '10.0.0.5', port: 5353 });
  assert.equal(second.conflict, 'dup._esphomelib._tcp.local');
  assert.equal(events[0].yielded, true);
  second.announce();
  assert.equal(second.sent.length, 0, 'a device that yielded does not announce');
  const defends = [];
  first.device.on('mdns-conflict', (e) => defends.push(e));
  first._onMessage(second.packet(second.records()), { address: '10.0.0.6', port: 5353 });
  assert.equal(first.conflict, null);
  assert.equal(first.contested, 'dup._esphomelib._tcp.local');
  assert.equal(defends[0].yielded, false);
  assert.deepEqual(first.sent, ['224.0.0.251'], 're-announced to defend the name');
});

test('mDNS: stop() during the probe lets start() finish', { timeout: 5000 }, async () => {
  const dev = new Device({ name: 'stop-mid-probe', log: false, port: 0 });
  const starting = dev.start();
  await wait(50);
  await dev.stop();
  await starting;
  assert.equal(dev.mdns.socket, null);
});

test('FakeDevice hands action handlers a stand-in connection', async () => {
  const dev = new FakeDevice({ name: 'f' });
  dev.service({ name: 'who' }, (args, conn) => conn.peer);
  assert.equal(await dev.call('who'), 'fake:0');
});
