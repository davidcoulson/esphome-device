// Framing for the native API socket. Two flavours share one socket handler:
//   plaintext:  0x00, varuint payload length, varuint message type, payload
//   noise:      0x01, uint16 BE length, body   (body is handshake data or an encrypted record)
// A FrameReader turns the byte stream into { type, payload } messages once the connection is
// past its handshake; before that, noise frames are handed to the handshake state machine.

import { encodeVarint, decodeVarint } from './proto.mjs';
import { NoiseResponder } from './noise.mjs';

export const INDICATOR_PLAINTEXT = 0x00;
export const INDICATOR_NOISE = 0x01;
const MAX_FRAME = 65535;
const PROLOGUE_INIT = Buffer.from('NoiseAPIInit', 'ascii');

export class PlaintextFramer {
  constructor() { this.buf = Buffer.alloc(0); this.ready = true; }
  // Feed bytes; returns an array of { type, payload } for every complete frame.
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.buf.length < 3) break;
      if (this.buf[0] !== INDICATOR_PLAINTEXT) throw new Error(`bad plaintext indicator byte ${this.buf[0]}`);
      const len = decodeVarint(this.buf, 1); if (!len) break;
      const type = decodeVarint(this.buf, 1 + len[1]); if (!type) break;
      if (len[0] > MAX_FRAME) throw new Error('frame too large');
      const start = 1 + len[1] + type[1];
      if (this.buf.length < start + len[0]) break;
      out.push({ type: type[0], payload: this.buf.subarray(start, start + len[0]) });
      this.buf = this.buf.subarray(start + len[0]);
    }
    return out;
  }
  frame(type, payload) {
    return Buffer.concat([Buffer.from([INDICATOR_PLAINTEXT]), encodeVarint(payload.length), encodeVarint(type), payload]);
  }
}

// Noise framer. States: 'hello' (waiting for the client's empty hello frame) → 'handshake'
// (one message each way) → 'data'. Errors carry .reject with the text to send back.
export class NoiseFramer {
  constructor({ psk, name, mac }) {
    this.psk = psk; this.name = name; this.mac = mac;
    this.buf = Buffer.alloc(0);
    this.state = 'hello';
    this.ready = false;
    this.hs = null; this.send = null; this.recv = null;
  }
  // Returns the complete messages in the stream so far. Handshake replies are handed to
  // `write` as they are produced, so they reach the wire even when a later frame in the same
  // chunk turns out to be bad.
  feed(chunk, write = () => {}) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const messages = [];
    for (;;) {
      if (this.buf.length < 3) break;
      if (this.buf[0] !== INDICATOR_NOISE) { const e = new Error('Bad indicator byte'); e.reject = e.message; throw e; }
      const size = this.buf.readUInt16BE(1);
      if (this.buf.length < 3 + size) break;
      const body = this.buf.subarray(3, 3 + size);
      this.buf = this.buf.subarray(3 + size);
      if (this.state === 'hello') {
        // The client hello's contents (normally empty) become part of the prologue.
        const sizeBytes = Buffer.alloc(2); sizeBytes.writeUInt16BE(size);
        this.hs = new NoiseResponder(this.psk, Buffer.concat([PROLOGUE_INIT, sizeBytes, body]));
        // Server hello: protocol 0x01, node name, NUL, mac as 12 hex digits, NUL.
        write(this.frameRaw(Buffer.concat([Buffer.from([0x01]), Buffer.from(this.name, 'utf8'), Buffer.from([0]), Buffer.from(this.mac, 'ascii'), Buffer.from([0])])));
        this.state = 'handshake';
      } else if (this.state === 'handshake') {
        if (body.length === 0) { const e = new Error('Empty handshake message'); e.reject = e.message; throw e; }
        if (body[0] !== 0x00) { const e = new Error('Bad handshake error byte'); e.reject = e.message; throw e; }
        try { this.hs.readMessage(body.subarray(1)); }
        catch (err) { const e = new Error(err.message); e.reject = err.code === 'MAC' ? 'Handshake MAC failure' : 'Handshake error'; throw e; }
        const reply = this.hs.writeMessage();
        write(this.frameRaw(Buffer.concat([Buffer.from([0x00]), reply])));
        const keys = this.hs.split();
        this.send = keys.send; this.recv = keys.recv; this.hs = null;
        this.state = 'data'; this.ready = true;
      } else {
        let plain;
        try { plain = this.recv.decrypt(Buffer.alloc(0), body); }
        catch { throw new Error('decrypt failed'); }
        if (plain.length < 4) throw new Error('bad data packet');
        const type = plain.readUInt16BE(0), len = plain.readUInt16BE(2);
        if (len > plain.length - 4) throw new Error('bad data packet length');
        messages.push({ type, payload: plain.subarray(4, 4 + len) });
      }
    }
    return messages;
  }
  frameRaw(body) {
    if (body.length > MAX_FRAME) throw new Error('frame too large');
    const head = Buffer.alloc(3); head[0] = INDICATOR_NOISE; head.writeUInt16BE(body.length, 1);
    return Buffer.concat([head, body]);
  }
  frame(type, payload) {
    const head = Buffer.alloc(4); head.writeUInt16BE(type, 0); head.writeUInt16BE(payload.length, 2);
    return this.frameRaw(this.send.encrypt(Buffer.alloc(0), Buffer.concat([head, payload])));
  }
  // Explicit reject frame: 0x01 then the reason text. Sent before closing.
  rejectFrame(reason) {
    return this.frameRaw(Buffer.concat([Buffer.from([0x01]), Buffer.from(reason, 'ascii')]));
  }
}
