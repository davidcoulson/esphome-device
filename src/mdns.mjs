// A small multicast DNS responder that advertises the device as _esphomelib._tcp.local, which
// is how Home Assistant discovers ESPHome nodes. Only the records this service needs are
// implemented: PTR, SRV, TXT and A, with name compression understood on the way in.
//
// Before announcing, it probes for its host and instance names (RFC 6762 section 8) and stays
// quiet if another host already answers for them, so a second process with the same node name
// yields to the first. A device that has already announced keeps its name when a newcomer
// claims it: it warns, emits 'mdns-conflict' and announces again. Replies to queries from port
// 5353 go out by multicast even when a unicast reply was asked for, because several processes
// share that port on one host and a unicast datagram reaches only one of them. It only answers queries from addresses on its own networks, so an
// exposed port 5353 cannot be used to reflect traffic at a third party.
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
const MAX_LABEL = 63, MAX_NAME = 255, MAX_TXT_STRING = 255;
const PROBE_INTERVAL_MS = 250, PROBES = 3;

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

// Encode a DNS name, refusing what DNS cannot carry: a label over 63 bytes or a name over 255.
export function writeName(name) {
  const parts = [];
  for (const label of name.split('.').filter(Boolean)) {
    const b = Buffer.from(label, 'utf8');
    if (b.length > MAX_LABEL) throw new Error(`mDNS: label ${JSON.stringify(label)} is ${b.length} bytes, DNS allows ${MAX_LABEL}`);
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  const out = Buffer.concat(parts);
  if (out.length > MAX_NAME) throw new Error(`mDNS: name ${JSON.stringify(name)} is ${out.length} bytes encoded, DNS allows ${MAX_NAME}`);
  return out;
}

// Each TXT string is one length byte and up to 255 bytes. A longer key=value is an error rather
// than a silent cut, which would advertise half a value as if it were whole.
export function txtStrings(kv) {
  return Buffer.concat(Object.entries(kv).map(([k, v]) => {
    const b = Buffer.from(`${k}=${v}`, 'utf8');
    if (b.length > MAX_TXT_STRING) throw new Error(`mDNS: TXT entry ${JSON.stringify(k)} is ${b.length} bytes, DNS allows ${MAX_TXT_STRING}`);
    return Buffer.concat([Buffer.from([b.length]), b]);
  }));
}

function record(name, type, ttl, rdata, flush = false) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0); head.writeUInt16BE(CLASS_IN | (flush ? CACHE_FLUSH : 0), 2); head.writeUInt32BE(ttl, 4); head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([writeName(name), head, rdata]);
}

// Parse a whole mDNS message: questions, and every resource record from the answer, authority
// and additional sections. Returns null for anything too short to be DNS.
export function parseMessage(buf) {
  if (buf.length < 12) return null;
  const flags = buf.readUInt16BE(2);
  const counts = [4, 6, 8, 10].map((o) => buf.readUInt16BE(o));
  const questions = [], records = [];
  let at = 12;
  for (let i = 0; i < counts[0]; i++) {
    const { name, next } = readName(buf, at);
    questions.push({ name: name.toLowerCase(), type: buf.readUInt16BE(next), unicast: !!(buf.readUInt16BE(next + 2) & 0x8000) });
    at = next + 4;
  }
  const total = counts[1] + counts[2] + counts[3];
  for (let i = 0; i < total; i++) {
    const { name, next } = readName(buf, at);
    const type = buf.readUInt16BE(next), rdlen = buf.readUInt16BE(next + 8);
    const start = next + 10;
    if (start + rdlen > buf.length) throw new Error('truncated record');
    const rec = { name: name.toLowerCase(), type };
    if (type === TYPE.A && rdlen === 4) rec.address = [...buf.subarray(start, start + 4)].join('.');
    if (type === TYPE.SRV && rdlen >= 7) { rec.port = buf.readUInt16BE(start + 4); rec.target = readName(buf, start + 6).name.toLowerCase(); }
    records.push(rec);
    at = start + rdlen;
  }
  return { id: buf.readUInt16BE(0), response: !!(flags & 0x8000), questions, records };
}

function parseQuery(buf) {
  const m = parseMessage(buf);
  return m && !m.response ? m : null;
}

// IPv4 networks this host is on, as [address, netmask] number pairs.
function localNetworks() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4') out.push([ipToInt(a.address), ipToInt(a.netmask)]);
  }
  return out;
}
const ipToInt = (ip) => ip.split('.').reduce((n, o) => ((n << 8) | (Number(o) & 255)) >>> 0, 0);
export function isLocalSource(address, networks = localNetworks()) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return false;
  const ip = ipToInt(address);
  return networks.some(([net, mask]) => ((ip & mask) >>> 0) === ((net & mask) >>> 0));
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
    this.probe = opts.probe !== false;
    this.socket = null;
    this.timers = [];
    this.conflict = null;                                    // a name another host already held when we probed
    this.contested = null;                                   // a name someone claimed after we announced
    // Fail at construction, not on the first query, when a name or TXT entry cannot be encoded.
    writeName(this.instance); writeName(this.hostname); this.txtRecords();
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
    return txtStrings(kv);
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
    this.socket.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
    this.socket.on('error', (err) => this.device._log('warn', `mDNS: ${err.message}`));
    this.probing = this.probe;
    if (this.probe) await this._probe();
    this.probing = false;
    if (this.conflict || !this.socket) return;          // yielded, or stopped while probing
    // Announce a few times, then keep the record fresh every ~half TTL.
    for (const delay of [0, 1000, 3000]) this.timers.push(setTimeout(() => this.announce(), delay));
    this.timers.push(setInterval(() => this.announce(), 55_000));
  }

  // Ask three times, 250 ms apart, whether anyone already holds our names, then wait one more
  // interval for answers. A conflict is recorded by _onMessage.
  async _probe() {
    const names = [this.instance, this.hostname];
    // QM, not QU: answers come back by multicast, which every process on port 5353 receives.
    const q = Buffer.concat(names.map((n) => { const t = Buffer.alloc(4); t.writeUInt16BE(TYPE.ANY, 0); t.writeUInt16BE(CLASS_IN, 2); return Buffer.concat([writeName(n), t]); }));
    const auth = this.records().slice(1).filter((r, i) => i !== 1);   // SRV and A: what we intend to claim
    const head = Buffer.alloc(12); head.writeUInt16BE(names.length, 4); head.writeUInt16BE(auth.length, 8);
    const packet = Buffer.concat([head, q, ...auth]);
    for (let i = 0; i < PROBES && !this.conflict && this.socket; i++) {
      this.socket.send(packet, MDNS_PORT, MDNS_ADDR, () => {});
      // stop() wakes this wait, so stopping mid-probe cannot leave start() pending.
      await new Promise((r) => { this._wake = r; const t = setTimeout(r, PROBE_INTERVAL_MS); this.timers.push(t); });
      this._wake = null;
    }
  }

  // Whether a record from someone else's response claims one of our names with other data.
  // Our own records (looped back, or the same answer from a cache) are not a conflict.
  conflictIn(records, ours = { port: this.device.port, addresses: localAddresses(this.address) }) {
    const instance = this.instance.toLowerCase(), host = this.hostname.toLowerCase();
    for (const r of records) {
      if (r.name === instance && r.type === TYPE.SRV && (r.port !== ours.port || r.target !== host)) return this.instance;
      if (r.name === host && r.type === TYPE.A && r.address && !ours.addresses.includes(r.address)) return this.hostname;
    }
    return null;
  }

  announce(ttl = 120) {
    if (!this.socket || this.conflict) return;
    this.socket.send(this.packet(this.records(ttl)), MDNS_PORT, MDNS_ADDR, () => {});
  }

  _onMessage(msg, rinfo) {
    let m;
    try { m = parseMessage(msg); } catch { return; }
    if (!m) return;
    if (m.response) {
      const clash = this.conflictIn(m.records);
      if (!clash || this.conflict) return;
      if (this.probing) {
        // Someone held the name before us: yield.
        this.conflict = clash;
        this.device._log('warn', `mDNS: ${clash} is already answered by ${rinfo.address}; not advertising (add the device in Home Assistant by address, or give it another name)`);
        this.device.emit?.('mdns-conflict', { name: clash, from: rinfo.address, yielded: true });
      } else if (this.contested !== clash) {
        // We held it first: defend it, and say so once.
        this.contested = clash;
        this.device._log('warn', `mDNS: ${rinfo.address} also claims ${clash}; keeping it, but two devices share the name`);
        this.device.emit?.('mdns-conflict', { name: clash, from: rinfo.address, yielded: false });
        this.announce();
      }
      return;
    }
    if (this.probing || this.conflict) return;
    // Only answer the local network: a query from elsewhere is either misrouted or someone
    // trying to bounce our reply at a spoofed address.
    if (!isLocalSource(rinfo.address)) return;
    this._onQuery(m, rinfo);
  }

  _onQuery(q, rinfo) {
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
    // A legacy resolver (a source port other than 5353) gets a unicast reply with its query id.
    // Everything else gets multicast: a unicast reply to port 5353 may land on another process.
    const unicast = rinfo.port !== MDNS_PORT;
    const pkt = this.packet(answers, rinfo.port !== MDNS_PORT ? q.id : 0);
    if (unicast) this.socket.send(pkt, rinfo.port, rinfo.address, () => {});
    else this.socket.send(pkt, MDNS_PORT, MDNS_ADDR, () => {});
  }
  async stop() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
    this._wake?.();
    if (!this.socket) return;
    if (!this.conflict && !this.probing) await new Promise((r) => this.socket.send(this.packet(this.records(0)), MDNS_PORT, MDNS_ADDR, () => r()));
    await new Promise((r) => this.socket.close(() => r()));
    this.socket = null;
  }
}
