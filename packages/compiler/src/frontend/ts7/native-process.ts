import { Ts7Wire, type Ts7WireIo } from "./rpc-wire.js";
import { TS7_FILE_SYSTEM_CALLBACKS } from "./rpc-filesystem.js";
import { useNativeJsonValueEnd } from "./semantic-json.js";

// Bound by native/ts7-process.ffi.json. This module is a native entry point;
// the Node host continues to use rpc-process.ts's public spawn boundary.
declare function ts7NativeOpen(
  executable: string,
  cwd: string,
  callbacks: string,
  timing: boolean,
): number;
declare function ts7NativeRead(
  handle: number,
  bytes: Uint8Array,
  offset: number,
  length: number,
): number;
declare function ts7NativeWrite(
  handle: number,
  bytes: Uint8Array,
  offset: number,
  length: number,
): number;
declare function ts7NativePid(handle: number): number;
declare function ts7NativeClose(handle: number): void;
declare function ts7NativeCloseAll(): void;
declare function ts7NativeError(bytes: Uint8Array): number;
declare function ts7NativeJsonValueEnd(bytes: Uint8Array, start: number): number;

// Reply decoding finds element ends with the C scanner. FFI functions can
// only be called, not passed as values, so an arrow function calls it.
useNativeJsonValueEnd((bytes, start) => ts7NativeJsonValueEnd(bytes, start));

// process.exit skips C atexit handlers. Its ordinary exit listener closes
// servers too, while the C atexit sweep covers normal native termination.
process.on("exit", () => {
  ts7NativeCloseAll();
});

function nativeError(operation: string): Error {
  const bytes = new Uint8Array(1024);
  const length = ts7NativeError(bytes);
  return new Error(
    `TypeScript server ${operation}: ${Buffer.from(bytes.subarray(0, length)).toString("utf8")}`,
  );
}

/** Own a native server and its synchronous standard-input/output channel.
 * There is no shell, JS launcher, descriptor inheritance contract with the
 * caller, or dependency on Node's private stream handles. */
export class NativeTs7Process implements Ts7WireIo {
  private handle: number;
  readonly pid: number;

  constructor(executable: string, cwd: string, collectTiming = false) {
    this.handle = ts7NativeOpen(executable, cwd, TS7_FILE_SYSTEM_CALLBACKS, collectTiming);
    if (this.handle === 0) throw nativeError("startup");
    this.pid = ts7NativePid(this.handle);
  }

  private validateRange(buffer: Uint8Array, offset: number, length: number): void {
    if (this.handle === 0) throw new Error("TypeScript server transport is closed");
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset > buffer.length ||
      length > buffer.length - offset
    ) {
      throw new RangeError("TypeScript server transfer is outside the buffer");
    }
  }

  read = (buffer: Uint8Array, offset: number, length: number): number => {
    this.validateRange(buffer, offset, length);
    const count = ts7NativeRead(this.handle, buffer, offset, length);
    if (count < 0) {
      const error = nativeError("read");
      this.close();
      throw error;
    }
    return count;
  };

  write = (buffer: Uint8Array, offset: number, length: number): number => {
    this.validateRange(buffer, offset, length);
    const count = ts7NativeWrite(this.handle, buffer, offset, length);
    if (count < 0) {
      const error = nativeError("write");
      this.close();
      throw error;
    }
    return count;
  };

  close = (): void => {
    if (this.handle === 0) return;
    const handle = this.handle;
    this.handle = 0;
    ts7NativeClose(handle);
  };
}

export function spawnNativeTs7Wire(
  executable: string,
  cwd: string,
  collectTiming = false,
): Ts7Wire {
  return new Ts7Wire(new NativeTs7Process(executable, cwd, collectTiming));
}
