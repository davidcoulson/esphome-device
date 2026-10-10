// Compiled by `npm run typecheck`, never run: it fails the build if the declarations drift from
// how the library is used.
import { Device, DEFAULTS, type Connection } from '../../src/index.js';
import { FakeDevice } from '../../src/testing.js';

const dev = new Device({ name: 'x', maxConnections: 4, idleTimeoutMs: 5000, mdns: { probe: false } });
dev.button({ name: 'Go' }).on('press', () => {});
const bell = dev.event({ name: 'Bell', eventTypes: ['ring'] });
bell.on('fire', (t: string) => t.length);
bell.fire('ring');
dev.sensor({ name: 'Temp', stateClass: 'measurement' }).on('state', (v: number) => v.toFixed(1));
dev.service({ name: 'who', response: 'optional' }, (args, conn: Connection) => ({ peer: conn.peer, major: conn.apiVersion?.major }));
dev.on('mdns-conflict', ({ name, yielded }) => { if (yielded) console.log(name); });
dev.log('very_verbose', 'x');
const total: number = dev.limits.maxWriteBuffer + DEFAULTS.maxMessageSize;
const fake = new FakeDevice({ name: 'f' });
void fake.call('who', {}, fake.fakeConnection);
void total;
