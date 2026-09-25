import type { Device, DeviceOptions } from './index.js';
/** A Device with no sockets, for tests: records declarations, state pushes and actions, and plays Home Assistant. */
export class FakeDevice extends Device {
  constructor(opts?: Partial<DeviceOptions> & { name?: string });
  readonly declared: Array<{ kind: string; objectId: string; name: string } & Record<string, unknown>>;
  readonly pushed: Array<Record<string, unknown>>;
  readonly actions: Array<{ service: string; data: Record<string, unknown>; is_event: boolean }>;
  readonly logs: Array<{ level: string; message: string }>;
  readonly started: boolean;
  /** Send a command as Home Assistant would; resolves to the resulting state. */
  command(objectId: string, value?: unknown): Promise<unknown>;
  press(objectId: string): Promise<unknown>;
  /** Call a user-defined action; resolves to the handler's result. */
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Deliver a Home Assistant entity state the app subscribed to. */
  haState(entityId: string, state: string, attribute?: string): void;
}
