// Commands for one entity are applied in the order Home Assistant sent them, as on an ESPHome
// board, even when the handler is async and an earlier command takes longer than a later one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDevice } from '../src/testing.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a slow "on" followed by a fast "off" ends off', async () => {
  const dev = new FakeDevice({ name: 'order' });
  const calls = [];
  const sw = dev.switch({ name: 'Lamp' }, async (on) => { calls.push(`start ${on}`); await wait(on ? 80 : 5); calls.push(`end ${on}`); });
  const first = dev.command('lamp', true);
  const second = dev.command('lamp', false);
  await Promise.all([first, second]);
  assert.equal(sw.state, false, 'the last command wins');
  assert.deepEqual(calls, ['start true', 'end true', 'start false', 'end false'], 'handlers never overlap');
  assert.deepEqual(sw.sets, [true, false]);
});

test('a failed command does not stall the ones behind it', async () => {
  const dev = new FakeDevice({ name: 'order' });
  const n = dev.number({ name: 'Level', min: 0, max: 100 }, async (v) => { await wait(10); if (v === 13) throw new Error('unlucky'); });
  await Promise.all([dev.command('level', 13), dev.command('level', 42)]);
  assert.equal(n.state, 42);
});

test('each entity has its own queue', async () => {
  const dev = new FakeDevice({ name: 'order' });
  const seen = [];
  dev.switch({ name: 'Slow' }, async () => { await wait(60); seen.push('slow'); });
  dev.switch({ name: 'Fast' }, async () => { seen.push('fast'); });
  await Promise.all([dev.command('slow', true), dev.command('fast', true)]);
  assert.deepEqual(seen, ['fast', 'slow'], 'a slow entity does not hold up another');
});

test('button presses and update commands are queued too', async () => {
  const dev = new FakeDevice({ name: 'order' });
  const seen = [];
  dev.button({ name: 'Go' }, async () => { const n = seen.length; await wait(n === 0 ? 40 : 1); seen.push(n); });
  await Promise.all([dev.press('go'), dev.press('go'), dev.press('go')]);
  assert.deepEqual(seen, [0, 1, 2]);
  const order = [];
  dev.update({ name: 'Fw', state: { current: '1', latest: '2' } }, async (what) => { await wait(what === 'check' ? 30 : 1); order.push(what); });
  await Promise.all([dev.command('fw', 'check'), dev.command('fw', 'install')]);
  assert.deepEqual(order, ['check', 'install']);
});
