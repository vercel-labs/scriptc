import { EventEmitter } from "node:events";
import { PassThrough, Readable, Transform } from "node:stream";

export const errorKinds: ErrorConstructor[] = [TypeError, RangeError];
export const streamKinds: (typeof Readable)[] = [PassThrough, Transform];

export function build(Kind: typeof EventEmitter): EventEmitter {
  return new Kind();
}

export function describe(Kind: ErrorConstructor, message: string): string {
  const err = new Kind(message);
  return `${Kind.name}: ${err.message} (${err instanceof Kind})`;
}
