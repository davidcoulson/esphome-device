// Entity classes. Each knows its list/state/command message names and how to turn its own
// fields into the wire objects. Keys are FNV-1a hashes of the object id, as ESPHome does.

import { EventEmitter } from 'node:events';
import { EntityCategory, StateClass, NumberMode, TextMode } from './messages.mjs';

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(str, 'utf8')) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export function objectIdFrom(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'entity';
}

const categoryOf = (c) => typeof c === 'number' ? c : c === 'config' ? EntityCategory.CONFIG : c === 'diagnostic' ? EntityCategory.DIAGNOSTIC : EntityCategory.NONE;
const stateClassOf = (s) => typeof s === 'number' ? s : s === 'measurement' ? StateClass.MEASUREMENT : s === 'total_increasing' ? StateClass.TOTAL_INCREASING : s === 'total' ? StateClass.TOTAL : StateClass.NONE;

export class Entity extends EventEmitter {
  constructor(device, opts) {
    super();
    if (!opts?.name && !opts?.id) throw new Error('an entity needs a name or an id');
    this.device = device;
    this.name = opts.name ?? opts.id;
    this.objectId = opts.id ? objectIdFrom(opts.id) : objectIdFrom(this.name);
    this.key = opts.key ?? fnv1a(this.objectId);
    this.icon = opts.icon ?? '';
    this.category = categoryOf(opts.category);
    this.disabledByDefault = !!opts.disabledByDefault;
    this.deviceClass = opts.deviceClass ?? '';
    this._state = opts.state;              // undefined means "unknown" until set
  }
  get state() { return this._state; }
  set state(v) { this.set(v); }
  // Set the state and push it to every subscribed client. Returns true when it changed.
  set(v) {
    const changed = typeof v === 'object' && v !== null ? JSON.stringify(this._state) !== JSON.stringify(v) : this._state !== v;
    this._state = v;
    this.device._push(this, changed);
    if (changed) this.emit('state', v);
    return changed;
  }
  get hasState() { return this._state !== undefined && this._state !== null; }
  info() {
    return { object_id: this.objectId, key: this.key, name: this.name, icon: this.icon, disabled_by_default: this.disabledByDefault, entity_category: this.category };
  }
  stateMessage() { return null; }
  // Command handling: a subclass calls this with the requested value. The handler may return a
  // replacement value, nothing (adopt the request), or throw (keep the old state).
  async _command(value) {
    let result;
    try { result = this.handler ? await this.handler(value, this) : undefined; }
    catch (err) { this.device._log('warn', `${this.objectId}: command failed: ${err.message}`); this.device._push(this, true); return; }
    this.set(result === undefined ? value : result);
  }
}

export class BinarySensor extends Entity {
  static list = 'ListEntitiesBinarySensorResponse'; static stateMsg = 'BinarySensorStateResponse';
  info() { return { ...super.info(), device_class: this.deviceClass, is_status_binary_sensor: false }; }
  stateMessage() { return { key: this.key, state: !!this._state, missing_state: !this.hasState }; }
}

export class Sensor extends Entity {
  static list = 'ListEntitiesSensorResponse'; static stateMsg = 'SensorStateResponse';
  constructor(device, opts) {
    super(device, opts);
    this.unit = opts.unit ?? ''; this.accuracyDecimals = opts.accuracyDecimals ?? (Number.isInteger(opts.state) ? 0 : 1);
    this.stateClass = stateClassOf(opts.stateClass); this.forceUpdate = !!opts.forceUpdate;
  }
  info() { return { ...super.info(), unit_of_measurement: this.unit, accuracy_decimals: this.accuracyDecimals, force_update: this.forceUpdate, device_class: this.deviceClass, state_class: this.stateClass }; }
  get hasState() { return typeof this._state === 'number' && Number.isFinite(this._state); }
  stateMessage() { return { key: this.key, state: this.hasState ? this._state : NaN, missing_state: !this.hasState }; }
}

export class TextSensor extends Entity {
  static list = 'ListEntitiesTextSensorResponse'; static stateMsg = 'TextSensorStateResponse';
  info() { return { ...super.info(), device_class: this.deviceClass }; }
  stateMessage() { return { key: this.key, state: this.hasState ? String(this._state) : '', missing_state: !this.hasState }; }
}

export class Switch extends Entity {
  static list = 'ListEntitiesSwitchResponse'; static stateMsg = 'SwitchStateResponse'; static command = 'SwitchCommandRequest';
  constructor(device, opts, handler) { super(device, opts); this.assumedState = !!opts.assumedState; this.handler = handler; if (this._state === undefined) this._state = false; }
  info() { return { ...super.info(), assumed_state: this.assumedState, device_class: this.deviceClass }; }
  stateMessage() { return { key: this.key, state: !!this._state }; }
  onCommand(msg) { return this._command(!!msg.state); }
}

export class NumberEntity extends Entity {
  static list = 'ListEntitiesNumberResponse'; static stateMsg = 'NumberStateResponse'; static command = 'NumberCommandRequest';
  constructor(device, opts, handler) {
    super(device, opts); this.handler = handler;
    this.min = opts.min ?? 0; this.max = opts.max ?? 100; this.step = opts.step ?? 1; this.unit = opts.unit ?? '';
    this.mode = typeof opts.mode === 'number' ? opts.mode : opts.mode === 'box' ? NumberMode.BOX : opts.mode === 'slider' ? NumberMode.SLIDER : NumberMode.AUTO;
  }
  info() { return { ...super.info(), min_value: this.min, max_value: this.max, step: this.step, unit_of_measurement: this.unit, mode: this.mode, device_class: this.deviceClass }; }
  get hasState() { return typeof this._state === 'number' && Number.isFinite(this._state); }
  stateMessage() { return { key: this.key, state: this.hasState ? this._state : NaN, missing_state: !this.hasState }; }
  onCommand(msg) { return this._command(msg.state); }
}

export class Select extends Entity {
  static list = 'ListEntitiesSelectResponse'; static stateMsg = 'SelectStateResponse'; static command = 'SelectCommandRequest';
  constructor(device, opts, handler) { super(device, opts); this.options = [...(opts.options ?? [])]; this.handler = handler; }
  info() { return { ...super.info(), options: this.options }; }
  stateMessage() { return { key: this.key, state: this.hasState ? String(this._state) : '', missing_state: !this.hasState }; }
  onCommand(msg) {
    if (!this.options.includes(msg.state)) { this.device._log('warn', `${this.objectId}: unknown option ${JSON.stringify(msg.state)}`); return; }
    return this._command(msg.state);
  }
}

export class Button extends Entity {
  static list = 'ListEntitiesButtonResponse'; static command = 'ButtonCommandRequest';
  constructor(device, opts, handler) { super(device, opts); this.handler = handler; }
  info() { return { ...super.info(), device_class: this.deviceClass }; }
  async onCommand() {
    try { await this.handler?.(this); this.emit('press'); }
    catch (err) { this.device._log('warn', `${this.objectId}: press failed: ${err.message}`); }
  }
}

export class Text extends Entity {
  static list = 'ListEntitiesTextResponse'; static stateMsg = 'TextStateResponse'; static command = 'TextCommandRequest';
  constructor(device, opts, handler) {
    super(device, opts); this.handler = handler;
    this.minLength = opts.minLength ?? 0; this.maxLength = opts.maxLength ?? 255; this.pattern = opts.pattern ?? '';
    this.mode = opts.mode === 'password' ? TextMode.PASSWORD : TextMode.TEXT;
  }
  info() { return { ...super.info(), min_length: this.minLength, max_length: this.maxLength, pattern: this.pattern, mode: this.mode }; }
  stateMessage() { return { key: this.key, state: this.hasState ? String(this._state) : '', missing_state: !this.hasState }; }
  onCommand(msg) { return this._command(msg.state); }
}

export class Event extends Entity {
  static list = 'ListEntitiesEventResponse';
  constructor(device, opts) { super(device, opts); this.eventTypes = [...(opts.eventTypes ?? [])]; }
  info() { return { ...super.info(), device_class: this.deviceClass, event_types: this.eventTypes }; }
  fire(type) {
    if (!this.eventTypes.includes(type)) throw new Error(`${this.objectId}: event type ${JSON.stringify(type)} not declared`);
    this.device._send('EventResponse', { key: this.key, event_type: type });
    this.emit('fire', type);
  }
}

// Update entity: state is { current, latest, title, summary, url, inProgress, progress }. The
// handler gets 'install' or 'check' when Home Assistant asks; installing is the app's business.
export class Update extends Entity {
  static list = 'ListEntitiesUpdateResponse'; static stateMsg = 'UpdateStateResponse'; static command = 'UpdateCommandRequest';
  constructor(device, opts, handler) { super(device, opts); this.handler = handler; if (!this.deviceClass) this.deviceClass = 'firmware'; }
  info() { return { ...super.info(), device_class: this.deviceClass }; }
  get hasState() { return !!this._state?.current; }
  set(v) { return super.set(v ? { ...(this._state || {}), ...v } : v); }
  stateMessage() {
    const s = this._state || {};
    return { key: this.key, missing_state: !this.hasState, in_progress: !!s.inProgress, has_progress: typeof s.progress === 'number', progress: s.progress ?? 0,
      current_version: s.current ?? '', latest_version: s.latest ?? s.current ?? '', title: s.title ?? '', release_summary: s.summary ?? '', release_url: s.url ?? '' };
  }
  async onCommand(msg) {
    const what = msg.command === 1 ? 'install' : msg.command === 2 ? 'check' : null;
    if (!what) return;
    try { await this.handler?.(what, this); this.emit(what); }
    catch (err) { this.device._log('warn', `${this.objectId}: ${what} failed: ${err.message}`); }
  }
}

export const commandTypes = [Switch, NumberEntity, Select, Button, Text, Update];
