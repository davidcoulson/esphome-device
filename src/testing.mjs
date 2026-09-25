// A stand-in Device for the tests of apps that use this library: the same entity and service
// surface, no sockets. It records what was declared and what was set, and lets a test play Home
// Assistant by sending commands and calling actions.
//
//   import { FakeDevice } from 'esphome-device/testing';
//   const dev = new FakeDevice({ name: 'strimmer' });
//   const sw = dev.switch({ id: 'pause', name: 'Pause' }, (on) => on);
//   await dev.command('pause', true);          // runs the handler, sets the state like HA would
//   dev.declared.map((d) => d.kind + ':' + d.objectId);
//   sw.sets                                    // every value passed to .set(), in order

import { EventEmitter } from 'node:events';
import { fnv1a, objectIdFrom, BinarySensor, Sensor, TextSensor, Switch, NumberEntity, Select, Button, Text, Event, Update } from './entities.mjs';
import { macFromName } from './device.mjs';

export class FakeDevice extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.name = objectIdFrom(opts.name ?? 'fake').replace(/_/g, '-');
    this.friendlyName = opts.friendlyName ?? this.name;
    this.mac = { colons: opts.mac ?? macFromName(this.name), plain: (opts.mac ?? macFromName(this.name)).replace(/:/g, '') };
    this.port = opts.port ?? 6053;
    this.psk = opts.noiseKey ? Buffer.from(String(opts.noiseKey), 'base64') : null;
    this.entities = new Map();
    this.byKey = new Map();
    this.services = new Map();
    this.declared = [];                 // { kind, objectId, name, ...info }
    this.pushed = [];                   // { objectId, value } for every state push that changed
    this.actions = [];                  // callService / fireEvent calls
    this.logs = [];
    this.haSubscriptions = new Map();
    this.started = false;
    this.connections = new Set();
    this.logger = null;
  }
  get clients() { return []; }
  get connected() { return false; }

  _add(kind, entity) {
    if (this.entities.has(entity.objectId)) throw new Error(`duplicate entity id ${entity.objectId}`);
    this.entities.set(entity.objectId, entity); this.byKey.set(entity.key, entity);
    entity.kind = kind; entity.sets = [];
    const set = entity.set.bind(entity);
    entity.set = (v) => { entity.sets.push(v); return set(v); };
    this.declared.push({ kind, objectId: entity.objectId, name: entity.name, ...entity.info() });
    return entity;
  }
  binarySensor(o) { return this._add('binary_sensor', new BinarySensor(this, o)); }
  sensor(o) { return this._add('sensor', new Sensor(this, o)); }
  textSensor(o) { return this._add('text_sensor', new TextSensor(this, o)); }
  switch(o, h) { return this._add('switch', new Switch(this, o, h)); }
  number(o, h) { return this._add('number', new NumberEntity(this, o, h)); }
  select(o, h) { return this._add('select', new Select(this, o, h)); }
  button(o, h) { return this._add('button', new Button(this, o, h)); }
  text(o, h) { return this._add('text', new Text(this, o, h)); }
  event(o) { return this._add('event', new Event(this, o)); }
  update(o, h) { return this._add('update', new Update(this, o, h)); }
  service(opts, handler) {
    const name = objectIdFrom(opts.name);
    const svc = { name, key: fnv1a(name), args: Object.keys(opts.args ?? {}), handler, response: opts.response ?? 'none' };
    this.services.set(name, svc);
    return svc;
  }

  // ---- what a test does in Home Assistant's place -------------------------------------------
  // Send a command to a switch/number/select/text/button/update entity, as HA would.
  async command(objectId, value) {
    const e = this.entities.get(objectIdFrom(objectId));
    if (!e) throw new Error(`no entity ${objectId}`);
    if (!e.onCommand) throw new Error(`${objectId} takes no commands`);
    const msg = e.kind === 'update' ? { key: e.key, command: value === 'check' ? 2 : 1 } : { key: e.key, state: value };
    await e.onCommand(msg);
    return e.state;
  }
  press(objectId) { return this.command(objectId); }
  // Call a user-defined action with named args; returns the handler's result (or throws).
  async call(name, args = {}) {
    const svc = this.services.get(objectIdFrom(name));
    if (!svc) throw new Error(`no service ${name}`);
    return svc.handler?.(args, null);
  }
  // Deliver a Home Assistant entity state the app subscribed to.
  haState(entityId, state, attribute = '') { this._haState({ entity_id: entityId, state, attribute }); }

  // ---- the Device surface the entities and apps use -----------------------------------------
  callService(service, data = {}) { this.actions.push({ service, data, is_event: false }); return true; }
  fireEvent(event, data = {}) { this.actions.push({ service: event, data, is_event: true }); return true; }
  subscribeHomeAssistantState(entityId, attribute, handler) {
    if (typeof attribute === 'function') { handler = attribute; attribute = ''; }
    let sub = this.haSubscriptions.get(entityId);
    if (!sub) { sub = { attribute, handlers: new Set(), state: undefined }; this.haSubscriptions.set(entityId, sub); }
    sub.handlers.add(handler);
    return () => sub.handlers.delete(handler);
  }
  _haState(msg) { const sub = this.haSubscriptions.get(msg.entity_id); if (!sub) return; sub.state = msg.state; for (const h of sub.handlers) h(msg.state, msg.entity_id, msg.attribute); }
  log(level, message) { this.logs.push({ level, message }); }
  deviceInfo() { return { name: this.name, friendly_name: this.friendlyName, mac_address: this.mac.colons.toUpperCase() }; }
  _push(entity, changed) { if (changed) this.pushed.push({ objectId: entity.objectId, value: entity.state }); }
  _send(name, obj) { this.pushed.push({ message: name, ...obj }); }
  _log(level, msg) { this.logs.push({ level, message: msg }); }
  async start() { this.started = true; return this; }
  async stop() { this.started = false; }
}
