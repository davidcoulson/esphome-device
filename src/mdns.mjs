// A small multicast DNS responder that advertises the device as _esphomelib._tcp.local, which
// is how Home Assistant discovers ESPHome nodes. Only the records this service needs are
// implemented: PTR, SRV, TXT and A, with name compression understood on the way in.
//
// It shares port 5353 with whatever resolver the host runs (mDNSResponder, avahi) thanks to
// SO_REUSEADDR/REUSEPORT. In a container on a bridge network multicast never leaves the
// container: use host networking, or add the device in Home Assistant by IP instead.

import dgram from 'node:dgram';
import os from 'node:os';

const MDNS_ADDR = '224.0.0.251', MDNS_PORT = 5353;
const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 };
const SERVICE = '_esphomelib._tcp.local';
const CLASS_IN = 1, CACHE_FLUSH = 0x8000;

function readName(buf, at, depth = 0) {
  const labels = [];
  let end = null;
  for (;;) {
    if (at >= buf.length) throw new Error('truncated name');
    const len = buf[at];
    if (len === 0) { at += 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (depth > 8) throw new Error('compression loop');
      const ptr = ((len & 0x3f) << 8) | buf[at + 1];
      if (end === null) end = at + 2;
      const inner = readName(buf, ptr, depth + 1);
      labels.push(...inner.name.split('.').filter(Boolean));
      break;
    }
    labels.push(buf.toString('utf8', at + 1, at + 1 + len));
    at += 1 + len;
  }
  return { name: labels.join('.'), next: end ?? at };
}

function writeName(name) {
  const parts = [];
  for (const label of name.split('.').filter(Boolean)) { const b = Buffer.from(label, 'utf8'); parts.push(Buffer.from([b.length]), b); }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function record(name, type, ttl, rdata, flush = false) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0); head.writeUInt16BE(CLASS_IN | (flush ? CACHE_FLUSH : 0), 2); head.writeUInt32BE(ttl, 4); head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([writeName(name), head, rdata]);
}

function parseQuery(buf) {
  if (buf.length < 12) return null;
  const flags = buf.readUInt16BE(2);
  if (flags & 0x8000) return null;                          // a response, not a query
  const qd = buf.readUInt16BE(4);
  const questions = [];
  let at = 12;
  for (let i = 0; i < qd; i++) {
    const { name, next } = readName(buf, at);
    questions.push({ name: name.toLowerCase(), type: buf.readUInt16BE(next), unicast: !!(buf.readUInt16BE(next + 2) & 0x8000) });
    at = next + 4;
  }
  return { id: buf.readUInt16BE(0), questions };
}

export function localAddresses(preferred) {
  if (preferred) return [preferred];
  const out = [];
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
  }
  return out;
}

export class Advertiser {
  constructor(device, opts = {}) {
    this.device = device;
    this.address = opts.address ?? null;                     // IPv4 to advertise (default: every non-loopback one)
    this.txt = opts.txt ?? {};
    this.socket = null;
    this.timers = [];
  }
  get instance() { return `${this.device.name}.${SERVICE}`; }
  get hostname() { return `${this.device.name}.local`; }

  txtRecords() {
    const d = this.device;
    const kv = {
      version: d.esphomeVersion, mac: d.mac.plain, platform: 'NODE', board: os.platform(), network: 'ethernet',
      friendly_name: d.friendlyName,
      ...(d.project ? { project_name: d.project.name, project_version: d.project.version } : {}),
      ...(d.psk ? { api_encryption: 'Noise_NNpsk0_25519_ChaChaPoly_SHA256' } : {}),
      ...this.txt,
    };
    return Buffer.concat(Object.entries(kv).map(([k, v]) => { const b = Buffer.from(`${k}=${v}`, 'utf8'); return Buffer.concat([Buffer.from([Math.min(b.length, 255)]), b.subarray(0, 255)]); }));
  }
  records(ttl = 120, addresses = localAddresses(this.address)) {
    const srv = Buffer.alloc(6); srv.writeUInt16BE(0, 0); srv.writeUInt16BE(0, 2); srv.writeUInt16BE(this.device.port, 4);
    const answers = [
      record(SERVICE, TYPE.PTR, ttl ? 4500 : 0, writeName(this.instance)),
      record(this.instance, TYPE.SRV, ttl, Buffer.concat([srv, writeName(this.hostname)]), true),
      record(this.instance, TYPE.TXT, ttl ? 4500 : 0, this.txtRecords(), true),
      ...addresses.map((ip) => record(this.hostname, TYPE.A, ttl, Buffer.from(ip.split('.').map(Number)), true)),
    ];
    return answers;
  }
  packet(answers, id = 0) {
    const head = Buffer.alloc(12);
    head.writeUInt16BE(id, 0); head.writeUInt16BE(0x8400, 2); head.writeUInt16BE(0, 4); head.writeUInt16BE(answers.length, 6);
    return Buffer.concat([head, ...answers]);
  }

  async start() {
    // reusePort exists only on some platforms (Linux, FreeBSD); reuseAddr alone is enough on
    // macOS, where libuv sets SO_REUSEPORT for UDP as well.
    const bind = (opts) => new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', ...opts });
      sock.once('error', (err) => { sock.close(); reject(err); });
      sock.bind(MDNS_PORT, '0.0.0.0', () => { sock.removeAllListeners('error'); resolve(sock); });
    });
    this.socket = await bind({ reuseAddr: true, reusePort: true }).catch(() => bind({ reuseAddr: true }));
    for (const ip of localAddresses(this.address)) { try { this.socket.addMembership(MDNS_ADDR, ip); } catch {} }
    try { this.socket.setMulticastTTL(255); this.socket.setMulticastLoopback(true); } catch {}
    this.socket.on('message', (msg, rinfo) => this._onQuery(msg, rinfo));
    this.socket.on('error', (err) => this.device._log('warn', `mDNS: ${err.message}`));
    // Announce a few times, then keep the record fresh every ~half TTL.
    for (const delay of [0, 1000, 3000]) this.timers.push(setTimeout(() => this.announce(), delay));
    this.timers.push(setInterval(() => this.announce(), 55_000));
  }
  announce(ttl = 120) {
    if (!this.socket) return;
    this.socket.send(this.packet(this.records(ttl)), MDNS_PORT, MDNS_ADDR, () => {});
  }
  _onQuery(msg, rinfo) {
    let q;
    try { q = parseQuery(msg); } catch { return; }
    if (!q) return;
    const answers = [];
    const want = (name, type) => q.questions.some((x) => x.name === name && (x.type === type || x.type === TYPE.ANY));
    const all = this.records();
    if (want(SERVICE, TYPE.PTR) || want('_services._dns-sd._udp.local', TYPE.PTR)) answers.push(...all);
    else {
      if (want(this.instance.toLowerCase(), TYPE.SRV) || want(this.instance.toLowerCase(), TYPE.TXT)) answers.push(all[1], all[2], ...all.slice(3));
      if (want(this.hostname.toLowerCase(), TYPE.A)) answers.push(...all.slice(3));
    }
    if (want('_services._dns-sd._udp.local', TYPE.PTR)) answers.unshift(record('_services._dns-sd._udp.local', TYPE.PTR, 4500, writeName(SERVICE)));
    if (!answers.length) return;
    const unicast = rinfo.port !== MDNS_PORT || q.questions.some((x) => x.unicast);
    const pkt = this.packet(answers, rinfo.port !== MDNS_PORT ? q.id : 0);
    if (unicast) this.socket.send(pkt, rinfo.port, rinfo.address, () => {});
    else this.socket.send(pkt, MDNS_PORT, MDNS_ADDR, () => {});
  }
  async stop() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
    if (!this.socket) return;
    await new Promise((r) => this.socket.send(this.packet(this.records(0)), MDNS_PORT, MDNS_ADDR, () => r()));
    await new Promise((r) => this.socket.close(() => r()));
    this.socket = null;
  }
}
