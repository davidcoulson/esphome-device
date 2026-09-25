// Noise_NNpsk0_25519_ChaChaPoly_SHA256, responder side only, built on node:crypto.
// This is the handshake ESPHome uses when `api: encryption: key:` is set. Home Assistant is
// the initiator; we (the device) are the responder. Message pattern:
//   -> psk, e
//   <- e, ee
// Reference: the Noise spec (revision 34) and ESPHome's api_frame_helper_noise.cpp.

import { createHash, createHmac, createCipheriv, createDecipheriv, generateKeyPairSync, diffieHellman, createPublicKey } from 'node:crypto';

export const PROTOCOL_NAME = 'Noise_NNpsk0_25519_ChaChaPoly_SHA256';
const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const MAX_NONCE = 2n ** 64n - 1n;

const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
const hmac = (key, ...parts) => createHmac('sha256', key).update(Buffer.concat(parts)).digest();

// HKDF as the Noise spec defines it (HMAC-based, two or three outputs).
function hkdf(chainingKey, inputKeyMaterial, numOutputs) {
  const tempKey = hmac(chainingKey, inputKeyMaterial);
  const out1 = hmac(tempKey, Buffer.from([1]));
  const out2 = hmac(tempKey, out1, Buffer.from([2]));
  if (numOutputs === 2) return [out1, out2];
  const out3 = hmac(tempKey, out2, Buffer.from([3]));
  return [out1, out2, out3];
}

function nonceBytes(n) {
  const b = Buffer.alloc(12);      // 4 zero bytes then the 64-bit little-endian counter
  b.writeBigUInt64LE(n, 4);
  return b;
}

// One direction of traffic after the handshake: a key and a counter.
export class CipherState {
  constructor(key) { this.key = key; this.n = 0n; }
  encrypt(ad, plaintext) {
    if (this.n >= MAX_NONCE) throw new Error('nonce exhausted');
    const c = createCipheriv('chacha20-poly1305', this.key, nonceBytes(this.n++), { authTagLength: 16 });
    c.setAAD(ad, { plaintextLength: plaintext.length });
    return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  }
  decrypt(ad, ciphertext) {
    if (this.n >= MAX_NONCE) throw new Error('nonce exhausted');
    if (ciphertext.length < 16) throw new Error('ciphertext too short');
    const d = createDecipheriv('chacha20-poly1305', this.key, nonceBytes(this.n), { authTagLength: 16 });
    d.setAAD(ad, { plaintextLength: ciphertext.length - 16 });
    d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    const out = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
    this.n++;                         // only advance on success, matching the spec
    return out;
  }
}

function x25519() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(SPKI_X25519_PREFIX.length);
  return { pub, privateKey };
}

function dh(privateKey, peerPub) {
  const publicKey = createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, peerPub]), format: 'der', type: 'spki' });
  return diffieHellman({ privateKey, publicKey });
}

// Responder for NNpsk0. Usage:
//   const hs = new NoiseResponder(psk32, prologue)
//   hs.readMessage(msg1)            // "-> psk, e" from the initiator; returns its payload
//   const msg2 = hs.writeMessage()  // "<- e, ee"; afterwards hs.split() gives the transport keys
export class NoiseResponder {
  constructor(psk, prologue = Buffer.alloc(0)) {
    if (psk.length !== 32) throw new Error('psk must be 32 bytes');
    this.psk = psk;
    const name = Buffer.from(PROTOCOL_NAME, 'ascii');
    this.h = name.length <= 32 ? Buffer.concat([name, Buffer.alloc(32 - name.length)]) : sha256(name);
    this.ck = this.h;
    this.k = null;                                   // symmetric key once one is derived
    this.hsNonce = 0n;
    this.mixHash(prologue);
    this.re = null;
    this.e = null;
    this.done = false;
  }
  mixHash(data) { this.h = sha256(this.h, data); }
  mixKey(ikm) { const [ck, tempK] = hkdf(this.ck, ikm, 2); this.ck = ck; this.k = tempK; this.hsNonce = 0n; }
  mixKeyAndHash(ikm) {
    const [ck, tempH, tempK] = hkdf(this.ck, ikm, 3);
    this.ck = ck; this.mixHash(tempH); this.k = tempK; this.hsNonce = 0n;
  }
  encryptAndHash(plaintext) {
    if (!this.k) { this.mixHash(plaintext); return plaintext; }
    const c = createCipheriv('chacha20-poly1305', this.k, nonceBytes(this.hsNonce++), { authTagLength: 16 });
    c.setAAD(this.h, { plaintextLength: plaintext.length });
    const out = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
    this.mixHash(out);
    return out;
  }
  decryptAndHash(ciphertext) {
    if (!this.k) { this.mixHash(ciphertext); return ciphertext; }
    if (ciphertext.length < 16) throw new Error('handshake ciphertext too short');
    const d = createDecipheriv('chacha20-poly1305', this.k, nonceBytes(this.hsNonce), { authTagLength: 16 });
    d.setAAD(this.h, { plaintextLength: ciphertext.length - 16 });
    d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    let out;
    try { out = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]); }
    catch { const e = new Error('Handshake MAC failure'); e.code = 'MAC'; throw e; }
    this.hsNonce++;
    this.mixHash(ciphertext);
    return out;
  }

  // "-> psk, e": psk mixes in first, then the initiator's ephemeral public key (also mixed into
  // the key because of the psk modifier), then an encrypted (possibly empty) payload.
  readMessage(msg) {
    if (this.re) throw new Error('handshake message already read');
    this.mixKeyAndHash(this.psk);
    if (msg.length < 32) { const e = new Error('Handshake message too short'); e.code = 'MAC'; throw e; }
    this.re = Buffer.from(msg.subarray(0, 32));
    this.mixHash(this.re);
    this.mixKey(this.re);
    return this.decryptAndHash(msg.subarray(32));
  }

  // "<- e, ee": our ephemeral key, then the shared secret, then an encrypted payload.
  writeMessage(payload = Buffer.alloc(0)) {
    if (!this.re) throw new Error('read the initiator message first');
    this.e = x25519();
    this.mixHash(this.e.pub);
    this.mixKey(this.e.pub);
    this.mixKey(dh(this.e.privateKey, this.re));
    const enc = this.encryptAndHash(payload);
    this.done = true;
    return Buffer.concat([this.e.pub, enc]);
  }

  // Transport keys. Responder receives with c1 (initiator's sending key) and sends with c2.
  split() {
    if (!this.done) throw new Error('handshake not finished');
    const [k1, k2] = hkdf(this.ck, Buffer.alloc(0), 2);
    return { recv: new CipherState(k1), send: new CipherState(k2), handshakeHash: this.h };
  }
}

// Initiator, used by the tests so the handshake can be exercised without Home Assistant.
export class NoiseInitiator {
  constructor(psk, prologue = Buffer.alloc(0)) {
    this.r = new NoiseResponder(psk, prologue);           // reuse the symmetric-state helpers
  }
  writeMessage(payload = Buffer.alloc(0)) {
    const s = this.r;
    s.mixKeyAndHash(s.psk);
    this.e = x25519();
    s.mixHash(this.e.pub);
    s.mixKey(this.e.pub);
    return Buffer.concat([this.e.pub, s.encryptAndHash(payload)]);
  }
  readMessage(msg) {
    const s = this.r;
    const re = Buffer.from(msg.subarray(0, 32));
    s.mixHash(re);
    s.mixKey(re);
    s.mixKey(dh(this.e.privateKey, re));
    const out = s.decryptAndHash(msg.subarray(32));
    s.done = true;
    return out;
  }
  split() {
    const [k1, k2] = hkdf(this.r.ck, Buffer.alloc(0), 2);
    return { send: new CipherState(k1), recv: new CipherState(k2), handshakeHash: this.r.h };
  }
}

export function parsePsk(key) {
  if (Buffer.isBuffer(key)) { if (key.length !== 32) throw new Error('noise key must be 32 bytes'); return key; }
  const buf = Buffer.from(String(key).trim(), 'base64');
  if (buf.length !== 32) throw new Error('noise key must be 32 bytes of base64 (44 characters)');
  return buf;
}
