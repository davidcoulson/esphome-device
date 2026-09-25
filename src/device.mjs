// A virtual ESPHome device: a TCP server on port 6053 that speaks the native API so Home
// Assistant's ESPHome integration can add it like any board, with entities you define in code.

import { EventEmitter } from 'node:events';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { encode, decode } from './proto.mjs';
import { byName, byId, LogLevel, ServiceArgType, SupportsResponse, DisconnectReason } from './messages.mjs';
import { PlaintextFramer, NoiseFramer, INDICATOR_NOISE } from './frame.mjs';
import { parsePsk } from './noise.mjs';
import { fnv1a, objectIdFrom, BinarySensor, Sensor, TextSensor, Switch, NumberEntity, Select, Button, Text, Event, Update } from './entities.mjs';
import { Advertiser } from './mdns.mjs';

export const API_VERSION = { major: 1, minor: 10 };
const PING_EVERY_MS = 30_000;
const IDLE_DROP_MS = 90_000;
const LOG_LEVELS = { error: LogLevel.ERROR, warn: LogLevel.WARN, info: LogLevel.INFO, config: LogLevel.CONFIG, debug: LogLevel.DEBUG, verbose: LogLevel.VERBOSE };

// Stable, locally administered MAC derived from a name: use when the host has no MAC worth
// exposing (containers) but Home Assistant still needs a unique id that survives restarts.
export function macFromName(name) {
  const h = createHash('sha256').update(`esphome-device:${name}`).digest();
  h[0] = (h[0] | 0x02) & 0xfe;                       // locally administered, unicast
  return [...h.subarray(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join(':');
}

function normaliseMac(mac) {
  const hex = String(mac).toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) throw new Error('mac must be 12 hex digits');
  return { colons: hex.match(/../g).join(':'), plain: hex };
}

const RESPONSE_MODES = { none: SupportsResponse.NONE, optional: SupportsResponse.OPTIONAL, only: SupportsResponse.ONLY, status: SupportsResponse.STATUS };
const argTypeOf = (t) => ({ bool: 0, int: 1, float: 2, string: 3, 'bool[]': 4, 'int[]': 5, 'float[]': 6, 'string[]': 7 })[t];
const argValue = (type, a) => [a.bool_, a.int_, a.float_, a.string_, a.bool_array, a.int_array, a.float_array, a.string_array][type];

class Connection {
  constructor(device, socket) {
    this.device = device; this.socket = socket;
    this.peer = `${socket.remoteAddress}:${socket.remotePort}`;
    this.framer = null;                                  // chosen from the first byte
    this.hello = false; this.authed = !device.password; this.connected = false;
    this.subscribedStates = false; this.logLevel = LogLevel.NONE; this.wantsServices = false; this.wantsHaStates = false;
    this.clientInfo = '';
    this.lastSeen = Date.now();
    this.pingTimer = setInterval(() => this._keepalive(), PING_EVERY_MS);
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this.device._log('debug', `${this.peer}: ${err.message}`));
    socket.on('close', () => this._closed());
  }

  _onData(chunk) {
    this.lastSeen = Date.now();
    try {
      if (!this.framer) {
        const wantsNoise = chunk[0] === INDICATOR_NOISE;
        if (wantsNoise && !this.device.psk) { this.device._log('warn', `${this.peer}: client wants encryption but no noise key is set`); return this.close(); }
        if (!wantsNoise && this.device.psk && !this.device.allowPlaintext) { this.device._log('warn', `${this.peer}: client sent plaintext but a noise key is required`); return this.close(); }
        this.framer = wantsNoise
          ? new NoiseFramer({ psk: this.device.psk, name: this.device.name, mac: this.device.mac.plain })
          : new PlaintextFramer();
      }
      const messages = this.framer.feed(chunk, (buf) => this.socket.write(buf));
      for (const m of messages) this._onMessage(m.type, m.payload);
    } catch (err) {
      this.device._log('warn', `${this.peer}: ${err.message}`);
      if (err.reject && this.framer?.rejectFrame) { try { this.socket.write(this.framer.rejectFrame(err.reject)); } catch {} }
      this.close();
    }
  }

  send(name, obj = {}) {
    if (!this.framer?.ready || this.socket.destroyed) return false;
    const schema = byName[name];
    if (!schema) throw new Error(`unknown message ${name}`);
    try { this.socket.write(this.framer.frame(schema.id, encode(schema, obj))); return true; }
    catch (err) { this.device._log('warn', `${this.peer}: send ${name} failed: ${err.message}`); this.close(); return false; }
  }

  _onMessage(type, payload) {
    const schema = byId.get(type);
    if (!schema) { this.device._log('debug', `${this.peer}: ignoring message type ${type}`); return; }
    const msg = decode(schema, payload);
    const d = this.device;
    if (!this.hello && schema.name !== 'HelloRequest') { d._log('warn', `${this.peer}: ${schema.name} before HelloRequest`); return this.close(); }
    switch (schema.name) {
      case 'HelloRequest':
        this.hello = true; this.clientInfo = msg.client_info;
        d._log('debug', `${this.peer}: hello from ${msg.client_info} (api ${msg.api_version_major}.${msg.api_version_minor})`);
        this.send('HelloResponse', { ...API_VERSION_FIELDS, server_info: d.serverInfo, name: d.name });
        if (this.authed) this._becomeConnected();
        return;
      case 'AuthenticationRequest': {
        const ok = !d.password || msg.password === d.password;
        this.send('AuthenticationResponse', { invalid_password: !ok });
        if (ok) { this.authed = true; this._becomeConnected(); } else { d._log('warn', `${this.peer}: wrong password`); this.close(); }
        return;
      }
      case 'PingRequest': this.send('PingResponse'); return;
      case 'PingResponse': return;
      case 'DisconnectRequest': this.send('DisconnectResponse'); this.close(); return;
      case 'DisconnectResponse': this.close(); return;
    }
    if (!this.authed) { d._log('warn', `${this.peer}: ${schema.name} before authentication`); return this.close(); }
    switch (schema.name) {
      case 'DeviceInfoRequest': this.send('DeviceInfoResponse', d.deviceInfo()); return;
      case 'ListEntitiesRequest':
        for (const e of d.entities.values()) this.send(e.constructor.list, e.info());
        for (const s of d.services.values()) this.send('ListEntitiesServicesResponse', s.info());
        this.send('ListEntitiesDoneResponse');
        return;
      case 'SubscribeStatesRequest':
        this.subscribedStates = true;
        for (const e of d.entities.values()) this._sendState(e);
        return;
      case 'SubscribeLogsRequest': this.logLevel = msg.level; return;
      case 'SubscribeHomeassistantServicesRequest': this.wantsServices = true; d._flushActions(); return;
      case 'SubscribeHomeAssistantStatesRequest':
        this.wantsHaStates = true;
        for (const [entityId, sub] of d.haSubscriptions) this.send('SubscribeHomeAssistantStateResponse', { entity_id: entityId, attribute: sub.attribute, once: false });
        return;
      case 'HomeAssistantStateResponse': d._haState(msg); return;
      case 'GetTimeResponse': return;
      case 'GetTimeRequest': this.send('GetTimeResponse', { epoch_seconds: Math.floor(Date.now() / 1000) }); return;
      case 'NoiseEncryptionSetKeyRequest': this.send('NoiseEncryptionSetKeyResponse', { success: false }); return;
      case 'ExecuteServiceRequest': d._executeService(this, msg); return;
    }
    const entity = d.byKey.get(msg.key);
    if (entity?.constructor.command === schema.name) { entity.onCommand(msg); return; }
    d._log('debug', `${this.peer}: unhandled ${schema.name}`);
  }

  _becomeConnected() {
    if (this.connected) return;
    this.connected = true;
    this.device._log('info', `${this.peer}: connected (${this.clientInfo || 'unknown client'})`);
    this.device.emit('connect', this);
  }
  _sendState(e) {
    if (!e.constructor.stateMsg) return;
    this.send(e.constructor.stateMsg, e.stateMessage());
  }
  _keepalive() {
    if (Date.now() - this.lastSeen > IDLE_DROP_MS) { this.device._log('warn', `${this.peer}: no traffic for ${IDLE_DROP_MS / 1000}s, dropping`); return this.close(); }
    if (this.framer?.ready && this.hello) this.send('PingRequest');
  }
  close(reason) {
    if (this.socket.destroyed) return;
    if (reason !== undefined && this.framer?.ready) this.send('DisconnectRequest', { reason });
    this.socket.end();
    const t = setTimeout(() => this.socket.destroy(), 500); t.unref?.();
  }
  _closed() {
    clearInterval(this.pingTimer);
    this.device.connections.delete(this);
    if (this.connected) { this.device._log('info', `${this.peer}: disconnected`); this.device.emit('disconnect', this); }
  }
}
const API_VERSION_FIELDS = { api_version_major: API_VERSION.major, api_version_minor: API_VERSION.minor };

export class Device extends EventEmitter {
  constructor(opts = {}) {
    super();
    if (!opts.name) throw new Error('name is required');
    this.name = objectIdFrom(opts.name).replace(/_/g, '-');   // ESPHome node names are lowercase with hyphens
    this.friendlyName = opts.friendlyName ?? opts.name;
    this.mac = normaliseMac(opts.mac ?? macFromName(this.name));
    this.port = opts.port ?? 6053;
    this.host = opts.host ?? '0.0.0.0';
    this.psk = opts.noiseKey ? parsePsk(opts.noiseKey) : null;
    this.allowPlaintext = !!opts.allowPlaintext;
    this.password = opts.password ?? '';
    this.project = opts.project ?? null;                       // { name: 'vendor.thing', version: '1.2.3' }
    this.model = opts.model ?? `Node ${process.versions.node}`;
    this.manufacturer = opts.manufacturer ?? 'esphome-device';
    this.esphomeVersion = opts.esphomeVersion ?? '2025.12.0';
    this.area = opts.area ?? '';
    this.serverInfo = opts.serverInfo ?? `esphome-device on Node ${process.versions.node}`;
    this.compilationTime = opts.compilationTime ?? new Date().toUTCString();
    this.logger = opts.log === false ? null : (opts.log ?? console);
    this.entities = new Map();                                 // objectId → entity
    this.byKey = new Map();
    this.services = new Map();
    this.haSubscriptions = new Map();                          // entity_id → { attribute, handlers, state }
    this.connections = new Set();
    this.pendingActions = [];
    this.mdns = opts.mdns === false ? null : new Advertiser(this, typeof opts.mdns === 'object' ? opts.mdns : {});
    this.server = null;
  }

  // Clients past the hello (Home Assistant, the ESPHome dashboard...). `connected` is any of them.
  get clients() { return [...this.connections].filter((c) => c.connected); }
  get connected() { return this.clients.length > 0; }

  // ---- entities -----------------------------------------------------------------------------
  _add(entity) {
    if (this.entities.has(entity.objectId)) throw new Error(`duplicate entity id ${entity.objectId}`);
    if (this.byKey.has(entity.key)) throw new Error(`entity key collision for ${entity.objectId}`);
    this.entities.set(entity.objectId, entity); this.byKey.set(entity.key, entity);
    return entity;
  }
  binarySensor(opts) { return this._add(new BinarySensor(this, opts)); }
  sensor(opts) { return this._add(new Sensor(this, opts)); }
  textSensor(opts) { return this._add(new TextSensor(this, opts)); }
  switch(opts, handler) { return this._add(new Switch(this, opts, handler)); }
  number(opts, handler) { return this._add(new NumberEntity(this, opts, handler)); }
  select(opts, handler) { return this._add(new Select(this, opts, handler)); }
  button(opts, handler) { return this._add(new Button(this, opts, handler)); }
  text(opts, handler) { return this._add(new Text(this, opts, handler)); }
  event(opts) { return this._add(new Event(this, opts)); }
  update(opts, handler) { return this._add(new Update(this, opts, handler)); }

  // A user-defined action, shown in Home Assistant as esphome.<node>_<name>.
  //   args: { rating_key: 'string', seconds: 'int', loud: 'bool', level: 'float', tags: 'string[]' }
  //         or { query: { type: 'string', description: 'What to play', example: 'Blade Runner' } }
  //   response: 'none' (default) | 'optional' | 'only' | 'status'
  // Home Assistant declares every argument as required, so callers must pass them all.
  // With a response mode other than 'none', HA waits for the handler: a throw becomes the action's
  // error, and for 'optional'/'only' the handler's return value (a plain object, or anything else
  // wrapped as { result }) is what `response_variable` receives.
  service(opts, handler) {
    const name = objectIdFrom(opts.name);
    const args = Object.entries(opts.args ?? {}).map(([n, spec]) => {
      const t = typeof spec === 'string' ? spec : spec?.type;
      const type = argTypeOf(t); if (type === undefined) throw new Error(`service ${name}: unknown arg type ${t} for ${n}`);
      return { name: n, type, description: spec?.description ?? '', example: spec?.example ?? '' };
    });
    const key = fnv1a(name);
    const response = RESPONSE_MODES[opts.response ?? 'none'];
    if (response === undefined) throw new Error(`service ${name}: response must be none, optional, only or status`);
    const svc = { name, key, args, handler, response, description: opts.description ?? '',
      info() { return { name, key, args, supports_response: response, description: this.description }; } };
    this.services.set(key, svc);
    return svc;
  }
  async _executeService(conn, msg) {
    const svc = this.services.get(msg.key);
    if (!svc) return this._log('warn', `${conn.peer}: unknown service key ${msg.key}`);
    const args = {};
    svc.args.forEach((a, i) => { args[a.name] = msg.args[i] ? argValue(a.type, msg.args[i]) : undefined; });
    let result, error;
    try { result = await svc.handler?.(args, conn); }
    catch (err) { error = err; this._log('warn', `service ${svc.name} failed: ${err.message}`); }
    if (!msg.call_id) return;                            // fire and forget: HA is not waiting
    let response_data = Buffer.alloc(0);
    if (!error && msg.return_response) {
      const body = result !== null && typeof result === 'object' && !Array.isArray(result) ? result : { result: result ?? null };
      try { response_data = Buffer.from(JSON.stringify(body), 'utf8'); }
      catch (err) { error = new Error(`response is not JSON: ${err.message}`); }
    }
    conn.send('ExecuteServiceResponse', { call_id: msg.call_id, success: !error, error_message: error ? String(error.message || error) : '', response_data });
  }

  // ---- talking to Home Assistant -------------------------------------------------------------
  // Call a Home Assistant action (service) — delivered to every client that subscribed to
  // device-originated actions, which the HA integration does once "Allow the device to perform
  // Home Assistant actions" is enabled for it.
  callService(service, data = {}) { return this._action({ service, data: toMap(data) }); }
  fireEvent(event, data = {}) { return this._action({ service: event, data: toMap(data), is_event: true }); }
  _action(msg) {
    const targets = [...this.connections].filter((c) => c.wantsServices);
    if (!targets.length) { this.pendingActions.push(msg); if (this.pendingActions.length > 50) this.pendingActions.shift(); return false; }
    for (const c of targets) c.send('HomeassistantActionRequest', msg);
    return true;
  }
  _flushActions() {
    const queued = this.pendingActions.splice(0);
    for (const m of queued) this._action(m);
  }
  // Follow a Home Assistant entity's state (or one attribute of it). Handler gets (state, entityId).
  subscribeHomeAssistantState(entityId, attribute, handler) {
    if (typeof attribute === 'function') { handler = attribute; attribute = ''; }
    let sub = this.haSubscriptions.get(entityId);
    if (!sub) { sub = { attribute: attribute ?? '', handlers: new Set(), state: undefined }; this.haSubscriptions.set(entityId, sub); }
    sub.handlers.add(handler);
    for (const c of this.connections) if (c.wantsHaStates) c.send('SubscribeHomeAssistantStateResponse', { entity_id: entityId, attribute: sub.attribute, once: false });
    return () => sub.handlers.delete(handler);
  }
  _haState(msg) {
    const sub = this.haSubscriptions.get(msg.entity_id);
    if (!sub) return;
    sub.state = msg.state;
    for (const h of sub.handlers) { try { h(msg.state, msg.entity_id, msg.attribute); } catch (err) { this._log('warn', `ha state handler: ${err.message}`); } }
  }
  // Send a log line to clients that subscribed to logs (the ESPHome dashboard, HA's log viewer).
  log(level, message) {
    const lvl = LOG_LEVELS[level] ?? LogLevel.INFO;
    const line = Buffer.from(`[${new Date().toISOString().slice(11, 19)}][${level[0].toUpperCase()}][${this.name}]: ${message}`, 'utf8');
    for (const c of this.connections) if (c.logLevel >= lvl) c.send('SubscribeLogsResponse', { level: lvl, message: line });
  }

  deviceInfo() {
    return {
      uses_password: !!this.password, name: this.name, friendly_name: this.friendlyName, mac_address: this.mac.colons.toUpperCase(),
      esphome_version: this.esphomeVersion, compilation_time: this.compilationTime, model: this.model, manufacturer: this.manufacturer,
      project_name: this.project?.name ?? '', project_version: this.project?.version ?? '', suggested_area: this.area,
      api_encryption_supported: !!this.psk, api_encryption_provisionable: false,
    };
  }

  // ---- internals ----------------------------------------------------------------------------
  _push(entity, changed) {
    if (!changed && !entity.forceUpdate) return;
    for (const c of this.connections) if (c.subscribedStates) c._sendState(entity);
  }
  _send(name, obj) { for (const c of this.connections) if (c.subscribedStates) c.send(name, obj); }
  _log(level, msg) {
    if (!this.logger) return;
    const fn = this.logger[level] ?? this.logger.log;
    if (level === 'debug' && !process.env.ESPHOME_DEVICE_DEBUG) return;
    fn?.call(this.logger, `[esphome-device ${this.name}] ${msg}`);
  }

  async start() {
    if (this.server) return this;
    this.server = net.createServer((socket) => this.connections.add(new Connection(this, socket)));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => { this.server.off('error', reject); resolve(); });
    });
    this.port = this.server.address().port;
    this.server.on('error', (err) => this.emit('error', err));
    this._log('info', `listening on ${this.host}:${this.port}${this.psk ? ' (noise encryption)' : ' (plaintext)'}`);
    if (this.mdns) await this.mdns.start().catch((err) => this._log('warn', `mDNS: ${err.message}`));
    return this;
  }
  async stop() {
    for (const c of this.connections) c.close(DisconnectReason.RESTARTING);
    if (this.mdns) await this.mdns.stop();
    if (this.server) await new Promise((r) => this.server.close(() => r()));
    this.server = null;
  }
}

const toMap = (obj) => Object.entries(obj).map(([key, value]) => ({ key, value: typeof value === 'string' ? value : JSON.stringify(value) }));
