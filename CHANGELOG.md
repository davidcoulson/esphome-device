# Changelog

## 0.3.1 — 2026-10-10

0.3.0 was tagged but never published; this release includes it.

- **Commands are applied in order.** Each entity's commands now run one at a time in the order
  Home Assistant sent them, as on an ESPHome board. Before, async handlers ran concurrently and
  whichever finished last won, so a slow "on" followed by a quick "off" could leave the entity
  on. Buttons and update commands are queued the same way; each entity has its own queue.
- **A low-order key from a client is a clean handshake rejection** ("Handshake error"), sent
  before the close, instead of an unexplained drop.
- **Noise is checked against outside implementations**: the published cacophony vector for this
  protocol and random transcripts from the Python `noise` library, byte for byte, in both roles.
  No discrepancy was found.
- **Seeded fuzzing** of the protobuf decoder, both framers, the mDNS parser and a live device.
  No crash, hang or over-buffering was found in 100,000 iterations per parser.
- **CI** runs the suite on every push and weekly against the newest `aioesphomeapi`, on Node 22,
  24 and current.

## 0.3.0 — 2026-10-10

Hardening from a full code review. The limits match ESPHome's own, so nothing that works with
an ESPHome board is refused here.

- **Frames are bounded at the header.** A plaintext length over `maxMessageSize` (32 KiB by
  default), a Noise data frame over that plus its header and tag, or a handshake frame over 128
  bytes is refused as soon as its length is readable, before the body is buffered. Overlong
  varints and message types above 65535 are refused too.
- **Connection limits.** `maxConnections` (8) caps open sockets; `handshakeTimeoutMs` (60 s) is
  an absolute deadline from accept to a finished hello and handshake; `idleTimeoutMs` (90 s)
  now counts only complete messages, so trickled bytes cannot hold a connection open; and
  `maxWriteBuffer` (1 MiB) drops a client that stopped reading instead of buffering for it
  without end. All are options, and `dev.limits` and `DEFAULTS` show them.
- **mDNS probes before announcing** and yields to a host that already holds the name, or
  defends a name it already announced; either way it warns and emits `mdns-conflict`.
- **mDNS answers only the local network**, so it cannot be used for reflection, and answers
  port-5353 queries by multicast, which every process sharing the port receives.
- **mDNS names and TXT entries are validated** at construction: a label over 63 bytes, a name
  over 255 or a TXT entry over 255 throws instead of going out malformed or silently cut.
- **A truncated protobuf fixed64 field is an error**, not a short message.
- **A server error after start no longer ends the process** when the app has no `error`
  listener; it is logged.
- **`dev.log('very_verbose', …)`** sends level 7; an unknown level falls back to info.
- `connection.apiVersion` records the client's version. The device still accepts any version,
  as ESPHome's firmware does; the README says so.
- `FakeDevice.call()` hands handlers a stand-in connection, matching the runtime and the types.
- Types for the limits, `Connection.apiVersion`, `mdns-conflict` and the lifecycle; the README
  has Lifecycle, API version and Discovery sections.

## 0.2.1 — 2026-10-02

- **A client without a key is told one is needed.** With `noiseKey` set, a plaintext hello now
  gets ESPHome's Noise-framed reject before the close, so Home Assistant's add flow asks for the
  encryption key (and an existing entry starts a reauth) instead of failing with "Unable to
  connect… make sure the YAML includes an api section".

## 0.2.0 — 2026-09-25

Learned from the first two apps on it (the theater panel and the Strimmer add-on).

- **Action responses.** `dev.service({ ..., response: 'optional' | 'only' | 'status' }, handler)`:
  Home Assistant waits for the handler, a throw becomes the action's error, and for
  `optional`/`only` the return value is what `response_variable` receives. No more publishing an
  answer on a text sensor.
- **Argument metadata.** `args: { query: { type: 'string', description, example } }` shows up in
  Home Assistant's developer tools.
- **`esphome-device/testing`** exports `FakeDevice`: the same surface with no sockets, recording
  declarations, pushes and actions, with `command()`, `press()`, `call()` and `haState()` to play
  Home Assistant in a test.
- **`dev.clients` and `dev.connected`** say whether anything is connected.
- **Type declarations** for the whole API.
- Docs: every declared action argument is required when called from Home Assistant; pass `id`
  so a renamed entity keeps its history; `NaN` is how a sensor says "unknown".

## 0.1.0 — 2026-09-24

First release: protobuf codec, Noise NNpsk0 responder, plaintext and Noise framing, mDNS,
binary_sensor / sensor / text_sensor / switch / number / select / button / text / event /
update entities, user-defined actions, HA action calls and state subscriptions, logs. Tested
against `aioesphomeapi`.
