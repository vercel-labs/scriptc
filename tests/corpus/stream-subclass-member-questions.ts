// A question about one member of a stream, asked through an untyped value,
// in a program that has classes of its own below the stream classes: such a
// class has members the runtime's streams do not have (`flush` here), so the
// answer for an instance of it is the class's, and a stream of the runtime's
// own class beside it still answers as it does alone
// (stream-member-questions.ts).
import {PassThrough, Readable, Writable} from 'node:stream';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function show(value: unknown): string {
  if (typeof value === 'function') return 'function';
  return typeof value + ':' + String(value);
}

class Sink extends Writable {
  flush(): number {
    return 1;
  }
  override _write(_chunk: Uint8Array | string, _encoding: string, callback: () => void): void {
    callback();
  }
}
class Loud extends Sink {
  override flush(): number {
    return -1;
  }
  shout(): string {
    return 'loud';
  }
}
class Quiet extends PassThrough {}

function hasFlush(h: unknown): boolean {
  return isObject(h) && typeof h.flush === 'function';
}

function subclass(tag: string, h: unknown): void {
  if (!isObject(h)) return;
  console.log(tag, 'flush', typeof h.flush, Reflect.has(h, 'flush'), h.flush === undefined, h.flush ? 'yes' : 'no', h.flush === h.flush, show(h.flush));
  console.log(tag, 'shout', typeof h.shout, Reflect.has(h, 'shout'), h.shout === undefined, h.shout ? 'yes' : 'no', show(h.shout));
  console.log(tag, 'flushHeaders', typeof h.flushHeaders, 'flushHeaders' in h, Reflect.has(h, 'flushHeaders'), h.flushHeaders === undefined, show(h.flushHeaders));
  console.log(tag, 'hasFlush', hasFlush(h));
}

function runtimeClass(tag: string, h: unknown): void {
  if (!isObject(h)) return;
  console.log(tag, 'flush', typeof h.flush, 'flush' in h, Reflect.has(h, 'flush'), h.flush === undefined, h.flush ? 'yes' : 'no', show(h.flush));
  console.log(tag, 'on', typeof h.on, 'on' in h, Reflect.has(h, 'on'), h.on === h.on);
  console.log(tag, 'destroyed', typeof h.destroyed, 'destroyed' in h, show(h.destroyed));
  console.log(tag, 'hasFlush', hasFlush(h));
}

subclass('Sink', new Sink());
subclass('Loud', new Loud());
subclass('Quiet', new Quiet());
const loud: unknown = new Loud();
subclass('Loud once', loud);
subclass('Loud twice', loud);
const typed = new Loud();
console.log('typed', typed.flush(), typed.shout(), hasFlush(typed));

// Streams of the runtime's classes beside the program's.
runtimeClass(
  'Writable',
  new Writable({
    write(_chunk: Uint8Array | string, _encoding: string, callback: () => void) {
      callback();
    },
  }),
);
runtimeClass('Readable', new Readable({read() {}}));
runtimeClass('PassThrough', new PassThrough());
