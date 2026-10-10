// Type declarations for esphome-device.
import { EventEmitter } from 'node:events';

export type Category = 'config' | 'diagnostic' | 0 | 1 | 2;
export type SensorStateClass = 'measurement' | 'total_increasing' | 'total' | 0 | 1 | 2 | 3;

export interface EntityOptions {
  /** Display name in Home Assistant. Required unless `id` is given. */
  name?: string;
  /** Object id (snake_case). Derived from `name` when omitted; pass it so a renamed entity keeps its history. */
  id?: string;
  /** Override the FNV-1a key (rarely needed). */
  key?: number;
  icon?: string;
  category?: Category;
  deviceClass?: string;
  disabledByDefault?: boolean;
}

/** What every entity has; each kind adds the events it emits. */
export interface EntityBase<T> extends EventEmitter {
  readonly objectId: string;
  readonly key: number;
  readonly name: string;
  state: T | undefined;
  /** Set the state and push it to subscribed clients. Returns true when it changed. */
  set(value: T | undefined): boolean;
}
export interface Entity<T> extends EntityBase<T> {
  on(event: 'state', listener: (value: T) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
}
export interface BinarySensor extends Entity<boolean> {}
export interface Sensor extends Entity<number> {}
export interface TextSensor extends Entity<string> {}
export interface Switch extends Entity<boolean> {}
export interface NumberEntity extends Entity<number> {}
export interface Select extends Entity<string> { readonly options: string[] }
export interface Text extends Entity<string> {}
export interface Button extends EntityBase<never> {
  on(event: 'press', listener: () => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
}
export interface EventEntity extends EntityBase<never> {
  fire(type: string): void;
  on(event: 'fire', listener: (type: string) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
}
export interface UpdateState { current?: string; latest?: string; title?: string; summary?: string; url?: string; inProgress?: boolean; progress?: number }
export interface UpdateEntity extends Entity<UpdateState> {}

/** Return nothing to accept the request, a value to substitute, or throw to keep the old state. */
export type CommandHandler<T, E> = (value: T, entity: E) => T | void | Promise<T | void>;

export type ArgType = 'bool' | 'int' | 'float' | 'string' | 'bool[]' | 'int[]' | 'float[]' | 'string[]';
export interface ArgSpec { type: ArgType; description?: string; example?: string }
export interface ServiceOptions {
  name: string;
  description?: string;
  /** Every declared argument is required when called from Home Assistant. */
  args?: Record<string, ArgType | ArgSpec>;
  /** 'none' (default): fire and forget. Otherwise Home Assistant waits: a throw is the action's error; for 'optional'/'only' the return value is the response. */
  response?: 'none' | 'optional' | 'only' | 'status';
}
export interface Service { readonly name: string; readonly key: number }
/** Receives the arguments by name and the connection that called (a stand-in under FakeDevice). */
export type ServiceHandler = (args: Record<string, any>, connection: Connection) => any;

export interface Connection {
  /** "address:port" of the client. */
  readonly peer: string;
  /** The client's own name from its hello, e.g. "Home Assistant 2026.9.3". */
  readonly clientInfo: string;
  /** The API version the client announced. The device accepts any; see API_VERSION. */
  readonly apiVersion: { major: number; minor: number } | null;
  /** True once the hello (and password, if one is set) is done. */
  readonly connected: boolean;
  close(reason?: number): void;
}

export interface Limits {
  /** Open sockets at once; more are closed on accept. Default 8, as ESPHome on a host. */
  maxConnections?: number;
  /** Time from accept to a finished hello (and Noise handshake). Absolute; traffic does not extend it. Default 60000. */
  handshakeTimeoutMs?: number;
  /** How often the device pings a connected client. Default 30000. */
  pingIntervalMs?: number;
  /** Drop a client after this long without a complete message. Default 90000. */
  idleTimeoutMs?: number;
  /** Largest message accepted from a client, checked at the frame header. Default 32768, as ESPHome. */
  maxMessageSize?: number;
  /** Bytes queued for a client that is not reading before it is dropped. Default 1 MiB. */
  maxWriteBuffer?: number;
}

export interface DeviceOptions extends Limits {
  /** Node name: lower-case with hyphens. Entity ids start with it. */
  name: string;
  friendlyName?: string;
  /** HA's unique id for the device; stable by default (derived from name). */
  mac?: string;
  port?: number;
  host?: string;
  /** Base64 32-byte Noise PSK. Omit for plaintext. */
  noiseKey?: string | Buffer;
  /** With a key set, also accept plaintext clients. */
  allowPlaintext?: boolean;
  /** Legacy API password (deprecated in HA). */
  password?: string;
  project?: { name: string; version: string };
  model?: string;
  manufacturer?: string;
  area?: string;
  esphomeVersion?: string;
  serverInfo?: string;
  compilationTime?: string;
  /** false to skip advertising; or { address, txt, probe }. probe: false skips the conflict check before announcing. */
  mdns?: boolean | { address?: string; txt?: Record<string, string>; probe?: boolean };
  /** Anything with info/warn (console by default); false for silence. */
  log?: false | { info?: (msg: string) => void; warn?: (msg: string) => void; debug?: (msg: string) => void; log?: (msg: string) => void };
}

export class Device extends EventEmitter {
  constructor(opts: DeviceOptions);
  readonly name: string;
  readonly friendlyName: string;
  readonly mac: { colons: string; plain: string };
  port: number;
  readonly entities: Map<string, EntityBase<any>>;
  /** Clients past the hello. */
  readonly clients: Connection[];
  readonly connected: boolean;
  /** The limits in force: the defaults with any options applied. */
  readonly limits: Required<Limits>;

  binarySensor(opts: EntityOptions & { state?: boolean }): BinarySensor;
  sensor(opts: EntityOptions & { unit?: string; accuracyDecimals?: number; stateClass?: SensorStateClass; forceUpdate?: boolean; state?: number }): Sensor;
  textSensor(opts: EntityOptions & { state?: string }): TextSensor;
  switch(opts: EntityOptions & { assumedState?: boolean; state?: boolean }, handler?: CommandHandler<boolean, Switch>): Switch;
  number(opts: EntityOptions & { min?: number; max?: number; step?: number; unit?: string; mode?: 'auto' | 'box' | 'slider'; state?: number }, handler?: CommandHandler<number, NumberEntity>): NumberEntity;
  select(opts: EntityOptions & { options: string[]; state?: string }, handler?: CommandHandler<string, Select>): Select;
  button(opts: EntityOptions, handler?: (entity: Button) => void | Promise<void>): Button;
  text(opts: EntityOptions & { minLength?: number; maxLength?: number; pattern?: string; mode?: 'text' | 'password'; state?: string }, handler?: CommandHandler<string, Text>): Text;
  event(opts: EntityOptions & { eventTypes: string[] }): EventEntity;
  update(opts: EntityOptions & { state?: UpdateState }, handler?: (what: 'install' | 'check', entity: UpdateEntity) => void | Promise<void>): UpdateEntity;
  service(opts: ServiceOptions, handler?: ServiceHandler): Service;

  /** Ask Home Assistant to run an action (needs "Allow the device to perform Home Assistant actions"). Queued until a client subscribes. */
  callService(service: string, data?: Record<string, unknown>): boolean;
  /** Fire the Home Assistant event `esphome.<event>`. */
  fireEvent(event: string, data?: Record<string, unknown>): boolean;
  subscribeHomeAssistantState(entityId: string, handler: (state: string, entityId: string, attribute: string) => void): () => void;
  subscribeHomeAssistantState(entityId: string, attribute: string, handler: (state: string, entityId: string, attribute: string) => void): () => void;
  /** Send a log line to clients that subscribed to logs. */
  log(level: 'error' | 'warn' | 'info' | 'config' | 'debug' | 'verbose' | 'very_verbose', message: string): void;

  /**
   * Listen (and advertise, unless mdns is false). Resolves once the port is open; rejects if it
   * cannot be (EADDRINUSE). Never waits for a client. An mDNS failure or conflict is logged and
   * does not fail start. Calling it again while running is a no-op.
   */
  start(): Promise<this>;
  /**
   * Send every client a DisconnectRequest (reason RESTARTING), send the mDNS goodbye, close the
   * port. Home Assistant marks the entities unavailable. Safe to call twice; start() works again after.
   */
  stop(): Promise<void>;
  on(event: 'connect' | 'disconnect', listener: (connection: Connection) => void): this;
  /** A server error after listening. Without a listener it is logged, not thrown. */
  on(event: 'error', listener: (err: Error) => void): this;
  /**
   * Another host claims this device's mDNS name. yielded: true when it held the name first (the
   * device then does not advertise); false when it arrived later (the device keeps advertising).
   */
  on(event: 'mdns-conflict', listener: (info: { name: string; from: string; yielded: boolean }) => void): this;
}

export const DEFAULTS: Required<Limits>;

export function macFromName(name: string): string;
export function fnv1a(str: string): number;
export function objectIdFrom(name: string): string;
export const API_VERSION: { major: number; minor: number };
export const EntityCategory: { NONE: 0; CONFIG: 1; DIAGNOSTIC: 2 };
export const StateClass: { NONE: 0; MEASUREMENT: 1; TOTAL_INCREASING: 2; TOTAL: 3 };
export const NumberMode: { AUTO: 0; BOX: 1; SLIDER: 2 };
export const TextMode: { TEXT: 0; PASSWORD: 1 };
export const LogLevel: Record<string, number>;
export const UpdateCommand: { NONE: 0; UPDATE: 1; CHECK: 2 };
export const DisconnectReason: Record<string, number>;
