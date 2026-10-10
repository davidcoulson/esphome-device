// Framing for the native API socket. Two flavours share one socket handler:
//   plaintext:  0x00, varuint payload length, varuint message type, payload
//   noise:      0x01, uint16 BE length, body   (body is handshake data or an encrypted record)
// A framer turns the byte stream into { type, payload } messages once the connection is past
// its handshake; before that, noise frames are handed to the handshake state machine.
//
// Every length is checked the moment it is readable, before any of the body is buffered, so a
// peer that announces a huge frame and then trickles it in is refused at the header. The limits
// are ESPHome's own: 32 KiB for a message (its ESP32 and host value) and 128 bytes for a
// handshake frame.

import { encodeVarint, decodeVarint } from './proto.mjs';
import { NoiseResponder } from './noise.mjs';

export const INDICATOR_PLAINTEXT = 0x00;
export const INDICATOR_NOISE = 0x01;
const MAX_FRAME = 65535;                 // what a noise frame's 16-bit length can say; the send-side cap
export const MAX_MESSAGE_SIZE = 32768;   // ESPHome's receive limit for a message on ESP32 and host
export const MAX_HANDSHAKE_SIZE = 128;   // ESPHome's limit for the hello and handshake frames
const MAX_TYPE = 0xffff;
const MAX_VARINT_BYTES = 5;              // a 32-bit varint; ESPHome reads no more for a length
const PROLOGUE_INIT = Buffer.from('NoiseAPIInit', 'ascii');

const protocolError = (message, reject) => Object.assign(new Error(message), reject ? { reject } : {});

export class PlaintextFramer {
  constructor({ maxMessageSize = MAX_MESSAGE_SIZE } = {}) {
    this.buf = Buffer.alloc(0); this.ready = true; this.maxMessageSize = maxMessageSize;
  }
  // Feed bytes; returns an array of { type, payload } for every complete frame.
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (!this.buf.length) break;
      if (this.buf[0] !== INDICATOR_PLAINTEXT) throw protocolError(`bad plaintext indicator byte ${this.buf[0]}`);
      const len = decodeVarint(this.buf, 1);
      if (!len) { if (this.buf.length > 1 + MAX_VARINT_BYTES) throw protocolError('bad length varint'); break; }
      if (len[1] > MAX_VARINT_BYTES) throw protocolError('bad length varint');
      // Refuse an oversized frame as soon as its length is known, before waiting for the body.
      if (len[0] > this.maxMessageSize) throw protocolError(`frame of ${len[0]} bytes exceeds the ${this.maxMessageSize}-byte limit`);
      const type = decodeVarint(this.buf, 1 + len[1]);
      if (!type) { if (this.buf.length > 1 + len[1] + MAX_VARINT_BYTES) throw protocolError('bad type varint'); break; }
      if (type[1] > MAX_VARINT_BYTES || type[0] > MAX_TYPE) throw protocolError(`message type ${type[0]} out of range`);
      const start = 1 + len[1] + type[1];
      if (this.buf.length < start + len[0]) break;
      out.push({ type: type[0], payload: this.buf.subarray(start, start + len[0]) });
      this.buf = this.buf.subarray(start + len[0]);
    }
    return out;
  }
  // Bytes held for a frame that has not finished arriving.
  get buffered() { return this.buf.length; }
  frame(type, payload) {
    return Buffer.concat([Buffer.from([INDICATOR_PLAINTEXT]), encodeVarint(payload.length), encodeVarint(type), payload]);
  }
}

// Noise framer. States: 'hello' (waiting for the client's empty hello frame) → 'handshake'
// (one message each way) → 'data'. Errors carry .reject with the text to send back.
export class NoiseFramer {
  constructor({ psk, name, mac, maxMessageSize = MAX_MESSAGE_SIZE } = {}) {
    this.psk = psk; this.name = name; this.mac = mac;
    // An encrypted record carries a 4-byte type and length header and a 16-byte tag around the message.
    this.maxDataFrame = Math.min(MAX_FRAME, maxMessageSize + 4 + 16);
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
      if (!this.buf.length) break;
      if (this.buf[0] !== INDICATOR_NOISE) throw protocolError('Bad indicator byte', 'Bad indicator byte');
      if (this.buf.length < 3) break;
      const size = this.buf.readUInt16BE(1);
      const limit = this.state === 'data' ? this.maxDataFrame : MAX_HANDSHAKE_SIZE;
      if (size > limit) throw protocolError(`frame of ${size} bytes exceeds the ${limit}-byte limit`, this.state === 'data' ? undefined : 'Bad handshake packet len');
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
        if (body.length === 0) throw protocolError('Empty handshake message', 'Empty handshake message');
        if (body[0] !== 0x00) throw protocolError('Bad handshake error byte', 'Bad handshake error byte');
        let reply;
        try { this.hs.readMessage(body.subarray(1)); reply = this.hs.writeMessage(); }
        catch (err) { throw protocolError(err.message, err.code === 'MAC' ? 'Handshake MAC failure' : 'Handshake error'); }
        write(this.frameRaw(Buffer.concat([Buffer.from([0x00]), reply])));
        const keys = this.hs.split();
        this.send = keys.send; this.recv = keys.recv; this.hs = null;
        this.state = 'data'; this.ready = true;
      } else {
        let plain;
        try { plain = this.recv.decrypt(Buffer.alloc(0), body); }
        catch { throw protocolError('decrypt failed'); }
        if (plain.length < 4) throw protocolError('bad data packet');
        const type = plain.readUInt16BE(0), len = plain.readUInt16BE(2);
        if (len > plain.length - 4) throw protocolError('bad data packet length');
        messages.push({ type, payload: plain.subarray(4, 4 + len) });
      }
    }
    return messages;
  }
  get buffered() { return this.buf.length; }
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
