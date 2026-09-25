# Changelog

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
