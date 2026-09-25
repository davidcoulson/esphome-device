# esphome-device

Be an ESPHome device from Node. This library speaks the **device side** of the ESPHome native
API, so Home Assistant's built-in ESPHome integration connects to your process and sees a
device with entities: sensors, switches, selects, numbers, buttons, text, events, update entities and
user-defined actions. No MQTT broker, no custom integration, no YAML.

- Zero dependencies (Node ≥ 22, `node:crypto` for the Noise handshake).
- Plaintext or **Noise** encryption (`Noise_NNpsk0_25519_ChaChaPoly_SHA256`), the same key
  format as `api: encryption: key:` in ESPHome.
- mDNS advertising so the device is discovered, or add it by IP and port.
- Push on change: a state goes out the moment you set it, to every subscribed client.
- Tested against `aioesphomeapi`, the client Home Assistant itself uses.

## Install

```bash
npm install esphome-device
```

## Use

```js
import { Device } from 'esphome-device';

const dev = new Device({
  name: 'theater-panel',                 // node name: HA prefixes entity ids with it
  friendlyName: 'Theater panel',
  noiseKey: process.env.NOISE_KEY,       // base64, 32 bytes; omit for plaintext
  project: { name: 'you.theater-panel', version: '1.0.0' },
  area: 'Home Theater',
});

const cinema = dev.switch({ name: 'Cinema mode', icon: 'mdi:theater' }, async (on) => {
  await setCinema(on);                   // throw to refuse; return a value to override
});
const streams = dev.sensor({ name: 'Streams', stateClass: 'measurement', accuracyDecimals: 0 });
const scene = dev.select({ name: 'Scene', options: ['Idle', 'Movie', 'Intermission'] }, (v) => go(v));
const picked = dev.event({ name: 'Mystery box', eventTypes: ['picked'] });
dev.button({ name: 'Surprise me' }, () => mystery());
dev.service({ name: 'play', args: { rating_key: 'string', preroll: 'bool' } }, ({ rating_key, preroll }) => play(rating_key, preroll));

await dev.start();

streams.set(2);                          // pushed to Home Assistant immediately
cinema.set(true);                        // state updates from your side too
picked.fire('picked');
dev.callService('light.turn_on', { entity_id: 'light.downlights', brightness: 40 });   // needs "allow device to perform actions" in HA
```

Then in Home Assistant: **Settings → Devices & services → Add integration → ESPHome**. On the
same network segment it is discovered; otherwise enter the host and port (6053) and, if you set
one, the encryption key.

### Entities

| Method | Home Assistant domain | Options beyond `name`, `id`, `icon`, `category`, `deviceClass`, `state` |
| --- | --- | --- |
| `binarySensor(opts)` | binary_sensor | |
| `sensor(opts)` | sensor | `unit`, `accuracyDecimals`, `stateClass` (`measurement`, `total_increasing`, `total`), `forceUpdate` |
| `textSensor(opts)` | sensor (text) | |
| `switch(opts, handler)` | switch | `assumedState` |
| `number(opts, handler)` | number | `min`, `max`, `step`, `unit`, `mode` (`auto`, `box`, `slider`) |
| `select(opts, handler)` | select | `options` |
| `button(opts, handler)` | button | |
| `text(opts, handler)` | text | `minLength`, `maxLength`, `pattern`, `mode` (`text`, `password`) |
| `event(opts)` | event | `eventTypes`; call `.fire(type)` |
| `update(opts, handler)` | update | state `{ current, latest, title, summary, url, inProgress, progress }`; handler gets `'install'` or `'check'` |
| `service(opts, handler)` | action `esphome.<node>_<name>` | `args: { name: 'string' \| 'int' \| 'float' \| 'bool' \| 'string[]' … }` |

Every entity has `.state`, `.set(value)` and emits `'state'`. Command handlers get the
requested value: return nothing to accept it, return a value to substitute, or throw to keep the
old state (Home Assistant's toggle springs back).

`stateClass` matters: without it the recorder keeps history but never builds long-term
statistics.

### Device options

| Option | Default | Notes |
| --- | --- | --- |
| `name` | required | lower-case with hyphens, like an ESPHome node name |
| `friendlyName` | `name` | what Home Assistant shows |
| `mac` | derived from `name` | HA's unique id for the device. `macFromName()` is stable across restarts; set your own to keep an existing device |
| `port`, `host` | 6053, `0.0.0.0` | |
| `noiseKey` | none | base64 32-byte PSK. Clients must then encrypt; add `allowPlaintext: true` to accept both |
| `password` | none | legacy API password (deprecated in HA, still honoured) |
| `project` | none | `{ name, version }`, shown on the device page |
| `model`, `manufacturer`, `area`, `esphomeVersion` | Node version, `esphome-device`, none, a current ESPHome version | HA gates a few features on the version string |
| `mdns` | `true` | `false` to skip advertising, or `{ address, txt }` |
| `log` | `console` | anything with `info`/`warn`; `false` for silence |

### Talking back to Home Assistant

- `dev.callService('domain.action', data)` and `dev.fireEvent('esphome.name', data)` send
  `HomeassistantActionRequest`; HA runs them once **Allow the device to perform Home Assistant
  actions** is enabled on the device's integration options. Calls made before HA subscribes are
  queued.
- `dev.subscribeHomeAssistantState('light.x', (state) => …)` asks HA to stream that entity's
  state to the device.
- `dev.log('info', 'text')` reaches anything that subscribed to logs (the ESPHome dashboard).

### Discovery in containers

mDNS is multicast: it only leaves a container on a host network (`network_mode: host`, or
`host_network: true` for a Home Assistant add-on). On a bridge network add the device by IP.

## How it works

`src/proto.mjs` is a schema-driven protobuf encoder/decoder for the wire types the API uses.
`src/messages.mjs` lists the message ids and fields. `src/frame.mjs` handles both framings and
`src/noise.mjs` the NNpsk0 responder handshake with ChaCha20-Poly1305 transport. `src/device.mjs`
is the TCP server, per-connection state machine and entity registry; `src/mdns.mjs` a small
multicast DNS responder.

## Tests

```bash
npm test
```

The acceptance test spawns Python's `aioesphomeapi` (`python3 -m venv .venv && .venv/bin/pip
install aioesphomeapi`) and drives the device through connect, device info, entity listing,
state subscription, every command type, device-originated actions, a user-defined action, HA
state subscription, logs and events, in plaintext and with Noise, plus wrong-key and
wrong-password rejections.

## License

MIT
