import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Device } from '../src/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const python = path.join(here, '..', '.venv', 'bin', 'python');

function build(opts) {
  const dev = new Device({ name: 'Node Test', friendlyName: 'Node test device', port: 0, mdns: false, log: false,
    project: { name: 'esphome-device.test', version: '0.1.0' }, ...opts });
  const calls = {};
  dev.switch({ name: 'Lamp' }, (on) => { calls.lamp = on; });
  dev.select({ name: 'Mode', options: ['Relax', 'Party'], state: 'Relax' }, (v) => { calls.mode = v; });
  dev.number({ name: 'Level', min: 0, max: 100, step: 5, state: 40 }, (v) => { calls.level = v; return v + 1; });  // handler adjusts
  dev.text({ name: 'Message' }, (v) => { calls.message = v; });
  dev.button({ name: 'Reboot' }, () => { calls.reboot = true; });
  const temp = dev.sensor({ name: 'Temperature', unit: '°C', accuracyDecimals: 1, state: 21.5 });
  dev.sensor({ name: 'Unknown', unit: '%' });
  const busy = dev.binarySensor({ name: 'Busy', state: false });
  dev.textSensor({ name: 'Status', state: 'idle' });
  const ev = dev.event({ name: 'Doorbell', eventTypes: ['pressed'] });
  dev.service({ name: 'say', args: { text: 'string', times: 'int', flags: 'bool[]', nums: 'int[]' } }, (args) => { calls.say = args; });
  dev.subscribeHomeAssistantState('light.desk', (state) => { calls.haState = state; });
  return { dev, calls, temp, busy, ev };
}

async function run(dev, key, password, on = () => {}) {
  const lines = [];
  const proc = spawn(python, [path.join(here, 'client.py'), String(dev.port), key ?? '', password ?? ''], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  let buf = '';
  proc.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = JSON.parse(buf.slice(0, i)); lines.push(l); on(l.step); buf = buf.slice(i + 1); } });
  const code = await new Promise((r) => proc.on('close', r));
  assert.equal(code, 0, `client exited ${code}\n${err}`);
  return Object.fromEntries(lines.map((l) => [l.step, l]));
}

async function exercise(opts, key, password) {
  const { dev, calls, temp, busy, ev } = build(opts);
  await dev.start();
  // Things the device does on its own, timed to land inside the client's waits.
  dev.on('connect', () => {
    // Queued before the client subscribes to device actions; flushed when it does.
    dev.callService('light.turn_on', { entity_id: 'light.desk', brightness: 200 }); dev.fireEvent('esphome.hello', { who: 'test' });
  });
  const on = (step) => {
    if (step === 'logs_subscribed') dev.log('info', 'a log line');
    if (step === 'waiting_final') { temp.set(23.4); busy.set(true); ev.fire('pressed'); }
  };
  try {
    const r = await run(dev, key, password, on);
    assert.equal(r.device_info.name, 'node-test');
    assert.equal(r.device_info.mac, dev.mac.colons.toUpperCase());
    assert.equal(r.device_info.friendly, 'Node test device');
    assert.equal(r.device_info.project, 'esphome-device.test');
    assert.equal(r.device_info.enc, !!key);
    assert.deepEqual(r.entities.entities.map((e) => e.split(':').slice(0, 2).join(':')).sort(), [
      'BinarySensorInfo:busy', 'ButtonInfo:reboot', 'EventInfo:doorbell', 'NumberInfo:level', 'SelectInfo:mode',
      'SensorInfo:temperature', 'SensorInfo:unknown', 'SwitchInfo:lamp', 'TextInfo:message', 'TextSensorInfo:status'].sort());
    assert.deepEqual(r.entities.services, [{ name: 'say', args: [['text', 3], ['times', 1], ['flags', 4], ['nums', 5]] }]);
    assert.equal(r.states.states.temperature, 21.5);
    assert.equal(r.states.states.unknown, 'missing');
    assert.equal(r.states.states.lamp, false);
    assert.equal(r.states.states.mode, 'Relax');
    assert.equal(r.states.states.status, 'idle');
    assert.equal(r.states.states.busy, false);
    assert.equal(r.after_commands.states.lamp, true);
    assert.equal(r.after_commands.states.mode, 'Party');
    assert.equal(r.after_commands.states.level, 66);
    assert.equal(r.after_commands.states.message, 'hello there');
    assert.deepEqual({ lamp: calls.lamp, mode: calls.mode, level: calls.level, message: calls.message, reboot: calls.reboot },
      { lamp: true, mode: 'Party', level: 65, message: 'hello there', reboot: true });
    assert.deepEqual(r.actions.actions, [
      { service: 'light.turn_on', data: { entity_id: 'light.desk', brightness: '200' }, is_event: false },
      { service: 'esphome.hello', data: { who: 'test' }, is_event: true }]);
    assert.deepEqual(calls.say, { text: 'hi', times: 3, flags: [true, false], nums: [-2, 7] });
    assert.deepEqual(r.ha_subs.subs, [['light.desk', '']]);
    assert.equal(calls.haState, 'on');
    assert.ok(r.logs.logs.some((l) => l.includes('a log line')), JSON.stringify(r.logs));
    assert.ok(Math.abs(r.final.states.temperature - 23.4) < 1e-5, 'sensor states travel as float32');
    assert.equal(r.final.states.busy, true);
    assert.equal(r.final.states.doorbell, 'pressed');
  } finally { await dev.stop(); }
}

test('plaintext: Home Assistant\'s client can drive the device end to end', { timeout: 30_000 }, async () => {
  await exercise({}, '', '');
});

test('noise: the same over an encrypted connection', { timeout: 30_000 }, async () => {
  const key = randomBytes(32).toString('base64');
  await exercise({ noiseKey: key }, key, '');
});

test('noise: wrong key is rejected with a handshake failure', { timeout: 30_000 }, async () => {
  const { dev } = build({ noiseKey: randomBytes(32).toString('base64') });
  await dev.start();
  try {
    await assert.rejects(run(dev, randomBytes(32).toString('base64'), ''), /InvalidEncryptionKeyAPIError|Handshake MAC failure|encryption/i);
  } finally { await dev.stop(); }
});

test('password: legacy password is checked', { timeout: 30_000 }, async () => {
  const { dev } = build({ password: 'secret' });
  await dev.start();
  try {
    await assert.rejects(run(dev, '', 'wrong'), /InvalidAuthAPIError|password/i);
    const r = await run(dev, '', 'secret');
    assert.equal(r.device_info.uses_password, true);
  } finally { await dev.stop(); }
});
