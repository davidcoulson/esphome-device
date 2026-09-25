// Run: node examples/basic.mjs   (then add it in Home Assistant: Settings → Integrations → ESPHome,
// it should be discovered, or enter this host's IP with port 6053)
import { Device } from '../src/index.mjs';

const dev = new Device({
  name: 'node-demo',
  friendlyName: 'Node demo',
  noiseKey: process.env.NOISE_KEY,           // base64, 32 bytes; leave unset for plaintext
  project: { name: 'esphome-device.demo', version: '0.1.0' },
  area: 'Office',
});

const light = dev.switch({ name: 'Desk lamp', icon: 'mdi:lamp' }, (on) => { console.log('lamp', on ? 'on' : 'off'); });
const temp = dev.sensor({ name: 'Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', accuracyDecimals: 1, state: 21.5 });
const mode = dev.select({ name: 'Mode', options: ['Relax', 'Focus', 'Party'], state: 'Relax' }, (v) => console.log('mode', v));
const level = dev.number({ name: 'Level', min: 0, max: 100, step: 5, mode: 'slider', state: 40 }, (v) => console.log('level', v));
dev.button({ name: 'Reboot', deviceClass: 'restart' }, () => console.log('pressed'));
dev.text({ name: 'Message' }, (v) => console.log('message', v));
const busy = dev.binarySensor({ name: 'Busy', deviceClass: 'running', state: false });
const status = dev.textSensor({ name: 'Status', state: 'idle', icon: 'mdi:information' });
const ev = dev.event({ name: 'Doorbell', eventTypes: ['pressed', 'held'], deviceClass: 'doorbell' });
dev.service({ name: 'say', args: { text: 'string', times: 'int' } }, (args) => console.log('say', args));

setInterval(() => {
  temp.set(Math.round((20 + Math.random() * 5) * 10) / 10);
  busy.set(!busy.state);
  status.set(busy.state ? 'working' : 'idle');
}, 10_000);
setInterval(() => ev.fire('pressed'), 60_000);

await dev.start();
process.on('SIGINT', async () => { await dev.stop(); process.exit(0); });
