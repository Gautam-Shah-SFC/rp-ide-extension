import { CaptureEvent } from "./CaptureEvent";

export type CaptureEventHandler = (event: CaptureEvent) => void;

/** Base contract every in-editor / agent capture adapter implements. */
export interface Provider {
  readonly id: string;
  readonly displayName: string;

  /** True if this provider's IDE/storage is actually present on this machine. */
  isAvailable(): Promise<boolean>;

  /** Start watching for new turns; call onEvent for each one found. */
  start(onEvent: CaptureEventHandler): Promise<void>;

  stop(): Promise<void>;
}
