// Just enough protocol buffers for the ESPHome native API: varint, fixed32/float, and
// length-delimited fields, driven by small schemas rather than generated code. The API only
// uses these wire types (see api.proto), so this is the whole encoder and decoder.
//
// A schema is { name, id, fields: { fieldName: [number, type] } } where type is one of
//   'string' 'bytes' 'bool' 'uint32' 'int32' 'sint32' 'enum' 'fixed32' 'float'
//   any of those followed by '[]' for a repeated field, or a nested schema object (or [schema] for
//   a repeated nested message).
// Unknown fields on decode are skipped, as protobuf requires.

const WIRE_VARINT = 0, WIRE_FIXED64 = 1, WIRE_LD = 2, WIRE_FIXED32 = 5;

export function encodeVarint(n) {
  // Unsigned 32-bit values only, which is all the API sends this way.
  n >>>= 0;
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}

// Returns [value, bytesRead] or null when the buffer ends mid-varint. Varints can be up to ten
// bytes (a negative int32 is sign-extended to 64 bits); only the low 32 bits are kept.
export function decodeVarint(buf, at = 0) {
  let result = 0, shift = 0, i = at;
  while (i < buf.length) {
    const b = buf[i++];
    if (shift < 32) result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result >>> 0, i - at];
    shift += 7;
    if (shift > 63) throw new Error('varint too long');
  }
  return null;
}

const wireFor = {
  string: WIRE_LD, bytes: WIRE_LD, message: WIRE_LD,
  bool: WIRE_VARINT, uint32: WIRE_VARINT, int32: WIRE_VARINT, sint32: WIRE_VARINT, enum: WIRE_VARINT,
  fixed32: WIRE_FIXED32, float: WIRE_FIXED32,
};

// A field spec is [num, type]; type may be a string, 'x[]', a schema, or [schema].
function specOf(type) {
  if (Array.isArray(type)) return { base: 'message', repeated: true, schema: type[0] };
  if (typeof type === 'object') return { base: 'message', repeated: false, schema: type };
  const repeated = type.endsWith('[]');
  return { base: repeated ? type.slice(0, -2) : type, repeated, schema: null };
}

function encodeField(num, type, value, parts) {
  const key = encodeVarint((num << 3) | wireFor[type]);
  switch (type) {
    case 'string': parts.push(key, encodeVarint(Buffer.byteLength(value)), Buffer.from(String(value), 'utf8')); return;
    case 'bytes': parts.push(key, encodeVarint(value.length), Buffer.from(value)); return;
    case 'bool': parts.push(key, encodeVarint(value ? 1 : 0)); return;
    case 'uint32': case 'enum': parts.push(key, encodeVarint(value)); return;
    case 'sint32': parts.push(key, encodeVarint(((value << 1) ^ (value >> 31)) >>> 0)); return;
    case 'int32': {
      // Negative int32 is ten bytes of varint in protobuf; the API's only int32 is
      // accuracy_decimals, which is never negative in practice, but be correct anyway.
      if (value >= 0) { parts.push(key, encodeVarint(value)); return; }
      const big = BigInt.asUintN(64, BigInt(value));
      const out = []; let v = big;
      while (v > 0x7fn) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
      out.push(Number(v));
      parts.push(key, Buffer.from(out)); return;
    }
    case 'fixed32': { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); parts.push(key, b); return; }
    case 'float': { const b = Buffer.alloc(4); b.writeFloatLE(value); parts.push(key, b); return; }
    default: throw new Error(`unknown field type ${type}`);
  }
}

function encodeMessageField(num, schema, value, parts) {
  const body = encode(schema, value);
  parts.push(encodeVarint((num << 3) | WIRE_LD), encodeVarint(body.length), body);
}

// Encode an object against a schema. Fields that are undefined, or equal to protobuf's default
// (0, false, ''), are left out, which is what proto3 does and what keeps messages small.
export function encode(schema, obj = {}) {
  const parts = [];
  for (const [name, [num, type]] of Object.entries(schema.fields)) {
    const v = obj[name];
    if (v === undefined || v === null) continue;
    const { base, repeated, schema: sub } = specOf(type);
    if (repeated) {
      for (const item of v) sub ? encodeMessageField(num, sub, item, parts) : encodeField(num, base, item, parts);
      continue;
    }
    if (sub) { encodeMessageField(num, sub, v, parts); continue; }
    if (v === 0 || v === false || v === '') continue;
    encodeField(num, base, v, parts);
  }
  return Buffer.concat(parts);
}

// Decode a buffer against a schema into a plain object with every field present at its default.
export function decode(schema, buf) {
  const byNum = new Map(Object.entries(schema.fields).map(([name, [num, type]]) => [num, { name, ...specOf(type) }]));
  const out = {};
  for (const [name, [, type]] of Object.entries(schema.fields)) {
    const { base, repeated, schema: sub } = specOf(type);
    out[name] = repeated ? [] : sub ? null : base === 'string' ? '' : base === 'bytes' ? Buffer.alloc(0) : base === 'bool' ? false : 0;
  }
  let at = 0;
  while (at < buf.length) {
    const tag = decodeVarint(buf, at);
    if (!tag) throw new Error('truncated tag');
    at += tag[1];
    const num = tag[0] >>> 3, wire = tag[0] & 7;
    const f = byNum.get(num);
    let value;
    if (wire === WIRE_VARINT) {
      const v = decodeVarint(buf, at); if (!v) throw new Error('truncated varint'); at += v[1];
      value = v[0];
      if (f) value = f.base === 'bool' ? value !== 0 : f.base === 'int32' ? (value | 0) : f.base === 'sint32' ? ((value >>> 1) ^ -(value & 1)) : value;
    } else if (wire === WIRE_FIXED32) {
      if (at + 4 > buf.length) throw new Error('truncated fixed32');
      value = f?.base === 'float' ? buf.readFloatLE(at) : buf.readUInt32LE(at); at += 4;
    } else if (wire === WIRE_LD) {
      const len = decodeVarint(buf, at); if (!len) throw new Error('truncated length'); at += len[1];
      if (at + len[0] > buf.length) throw new Error('truncated field');
      const slice = buf.subarray(at, at + len[0]); at += len[0];
      value = f?.schema ? decode(f.schema, slice) : f?.base === 'bytes' ? Buffer.from(slice) : slice.toString('utf8');
    } else if (wire === WIRE_FIXED64) {
      at += 8; continue;
    } else throw new Error(`unsupported wire type ${wire}`);
    if (!f) continue;                                   // a field this schema does not know: skipped
    if (f.repeated) out[f.name].push(value); else out[f.name] = value;
  }
  return out;
}
