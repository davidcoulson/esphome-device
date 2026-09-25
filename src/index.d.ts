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

export interface Entity<T> extends EventEmitter {
  readonly objectId: string;
  readonly key: number;
  readonly name: string;
  state: T | undefined;
  /** Set the state and push it to subscribed clients. Returns true when it changed. */
  set(value: T | undefined): boolean;
  on(event: 'state', listener: (value: T) => void): this;
}
export interface BinarySensor extends Entity<boolean> {}
export interface Sensor extends Entity<number> {}
export interface TextSensor extends Entity<string> {}
export interface Switch extends Entity<boolean> {}
export interface NumberEntity extends Entity<number> {}
export interface Select extends Entity<string> { readonly options: string[] }
export interface Text extends Entity<string> {}
export interface Button extends Entity<never> { on(event: 'press', listener: () => void): this }
export interface EventEntity extends Entity<never> { fire(type: string): void; on(event: 'fire', listener: (type: string) => void): this }
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
export type ServiceHandler = (args: Record<string, any>, connection: Connection | null) => any;

export interface Connection {
  readonly peer: string;
  readonly clientInfo: string;
  readonly connected: boolean;
  close(reason?: number): void;
}

export interface DeviceOptions {
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
  /** false to skip advertising; or { address, txt }. */
  mdns?: boolean | { address?: string; txt?: Record<string, string> };
  /** Anything with info/warn (console by default); false for silence. */
  log?: false | { info?: (msg: string) => void; warn?: (msg: string) => void; debug?: (msg: string) => void; log?: (msg: string) => void };
}

export class Device extends EventEmitter {
  constructor(opts: DeviceOptions);
  readonly name: string;
  readonly friendlyName: string;
  readonly mac: { colons: string; plain: string };
  port: number;
  readonly entities: Map<string, Entity<any>>;
  /** Clients past the hello. */
  readonly clients: Connection[];
  readonly connected: boolean;

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
  log(level: 'error' | 'warn' | 'info' | 'config' | 'debug' | 'verbose', message: string): void;

  start(): Promise<this>;
  stop(): Promise<void>;
  on(event: 'connect' | 'disconnect', listener: (connection: Connection) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

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
