// undici's response body (lib/api/readable.js): a readable byte stream fed
// by the dispatch handler, with the fetch body mixin (text/json/
// arrayBuffer/blob/bytes) and dump().
//
// It follows node:stream's Readable contract for the members it declares
// (flowing on a 'data' listener or resume(), pause(), 'data'/'end'/'close'/
// 'error' events and their ordering, destroy(err), back-pressure through
// push()'s return value), built on EventEmitter: scriptc compiles program
// classes extending EventEmitter under both its own Node declarations and
// @types/node, which a node:stream subclass does not get.
import { EventEmitter } from "node:events";
import { NotSupportedError, RequestAbortedError } from "./errors.ts";
import type { Profile } from "./types.ts";

const HIGH_WATER_MARK = 64 * 1024;

export class BodyReadable extends EventEmitter {
  __resumeFn: () => void;
  __abortFn: (err: Error) => void;
  __contentType: string;
  __consuming: boolean;
  __profile: Profile;
  __buffer: Buffer[];
  __length: number;
  __flowing: boolean;
  __ended: boolean;
  __endEmitted: boolean;
  __destroyed: boolean;
  __flowScheduled: boolean;
  __needsResume: boolean;

  constructor(
    resume: () => void,
    abort: (err: Error) => void,
    contentType: string,
    profile: Profile,
  ) {
    super();
    this.__resumeFn = resume;
    this.__abortFn = abort;
    this.__contentType = contentType;
    this.__consuming = false;
    this.__profile = profile;
    this.__buffer = [];
    this.__length = 0;
    this.__flowing = false;
    this.__ended = false;
    this.__endEmitted = false;
    this.__destroyed = false;
    this.__flowScheduled = false;
    this.__needsResume = false;
    // Readable.on('data') switches the stream to flowing mode.
    this.on("newListener", (event: string) => {
      if (event === "data" && !this.__flowing) this.resume();
    });
  }

  get destroyed(): boolean {
    return this.__destroyed;
  }

  get readableEnded(): boolean {
    return this.__endEmitted;
  }

  get readableLength(): number {
    return this.__length;
  }

  get readableFlowing(): boolean {
    return this.__flowing;
  }

  /** Readable.push: queue a chunk (null ends the body). Returns false once
   * the buffer reaches the high-water mark; the dispatcher then pauses the
   * connection until the consumer drains it. */
  push(chunk: Buffer | null): boolean {
    if (this.__destroyed || this.__ended) return false;
    if (chunk === null) {
      this.__ended = true;
      if (this.__length === 0) this.__scheduleEnd();
      else this.__scheduleFlow();
      return false;
    }
    if (this.__flowing && this.__length === 0 && this.listenerCount("data") > 0) {
      this.emit("data", chunk);
      return true;
    }
    this.__buffer.push(chunk);
    this.__length += chunk.length;
    if (this.__flowing) this.__scheduleFlow();
    const below = this.__length < HIGH_WATER_MARK;
    if (!below) this.__needsResume = true;
    return below;
  }

  resume(): this {
    if (!this.__flowing) {
      this.__flowing = true;
      this.__scheduleFlow();
    }
    return this;
  }

  pause(): this {
    this.__flowing = false;
    return this;
  }

  destroy(err?: Error): this {
    if (this.__destroyed) return this;
    this.__destroyed = true;
    let error: Error | null = err ?? null;
    if (error === null && !this.__endEmitted) error = new RequestAbortedError();
    if (error !== null) this.__abortFn(error);
    this.__buffer = [];
    this.__length = 0;
    const reported = error;
    process.nextTick(() => {
      if (reported !== null) this.emit("error", reported);
      this.emit("close");
    });
    return this;
  }

  __scheduleFlow(): void {
    if (this.__flowScheduled) return;
    this.__flowScheduled = true;
    process.nextTick(() => {
      this.__flowScheduled = false;
      this.__flow();
    });
  }

  __flow(): void {
    while (this.__flowing && !this.__destroyed && this.__buffer.length > 0) {
      const chunk = this.__buffer.shift()!;
      this.__length -= chunk.length;
      this.emit("data", chunk);
    }
    if (this.__destroyed) return;
    if (this.__needsResume && this.__length < HIGH_WATER_MARK) {
      this.__needsResume = false;
      this.__resumeFn();
    }
    if (this.__ended && this.__length === 0 && this.__flowing) this.__scheduleEnd();
  }

  __scheduleEnd(): void {
    process.nextTick(() => {
      if (this.__endEmitted || this.__destroyed || !this.__flowing || this.__length > 0) return;
      this.__endEmitted = true;
      this.emit("end");
      // autoDestroy: a fully read body closes.
      process.nextTick(() => {
        if (this.__destroyed) return;
        this.__destroyed = true;
        this.emit("close");
      });
    });
  }

  /** True once text()/json()/arrayBuffer()/bytes()/blob()/dump() started
   * consuming the body. */
  get bodyUsed(): boolean {
    return this.__consuming;
  }

  text(): Promise<string> {
    return this.__consume().then((bytes) => decodeText(bytes, this.__profile));
  }

  // undici declares json() as Promise<any>: callers assign the parsed value
  // to their own annotated types without a cast, exactly as with undici.
  // oxlint-disable-next-line typescript/no-explicit-any
  json(): Promise<any> {
    return this.__consume().then((bytes) => JSON.parse(decodeText(bytes, this.__profile)));
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return this.__consume().then((bytes) => {
      const out = new ArrayBuffer(bytes.length);
      new Uint8Array(out).set(bytes);
      return out;
    });
  }

  bytes(): Promise<Uint8Array> {
    return this.__consume().then((bytes) => new Uint8Array(bytes));
  }

  blob(): Promise<Blob> {
    return this.__consume().then((bytes) => new Blob([bytes], { type: this.__contentType }));
  }

  formData(): Promise<never> {
    return Promise.reject(new NotSupportedError());
  }

  /** Reads and discards up to `limit` bytes (default 256 KiB on 5.x, 128 KiB
   * on 7.x), then resolves; read errors are swallowed like undici's. */
  dump(opts?: { limit: number }): Promise<void> {
    let limit =
      opts !== undefined && Number.isFinite(opts.limit)
        ? opts.limit
        : this.__profile.major >= 7
          ? 131072
          : 262144;
    this.__consuming = true;
    return new Promise<void>((resolve) => {
      if (this.__endEmitted || this.__destroyed) {
        resolve();
        return;
      }
      this.on("data", (chunk: Buffer) => {
        limit -= chunk.length;
        if (limit < 0) {
          this.destroy();
          resolve();
        }
      });
      this.on("end", () => resolve());
      this.on("error", () => resolve());
      this.on("close", () => resolve());
    });
  }

  __consume(): Promise<Buffer> {
    if (this.bodyUsed) return Promise.reject(new TypeError("unusable"));
    this.__consuming = true;
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let done = false;
      this.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      this.on("end", () => {
        if (done) return;
        done = true;
        resolve(Buffer.concat(chunks));
      });
      this.on("error", (err: Error) => {
        if (done) return;
        done = true;
        reject(err);
      });
      this.on("close", () => {
        if (done) return;
        done = true;
        reject(new RequestAbortedError());
      });
    });
  }
}

/** 5.x decodes UTF-8 as-is; 7.x strips a leading byte-order mark first. */
function decodeText(bytes: Buffer, profile: Profile): string {
  if (
    profile.major >= 7 &&
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return bytes.subarray(3).toString("utf8");
  }
  return bytes.toString("utf8");
}
