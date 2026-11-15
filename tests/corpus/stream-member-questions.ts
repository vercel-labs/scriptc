// A question about one member of a stream, asked through an untyped value:
// `typeof h.flush`, `'flush' in h`, `Reflect.has(h, 'flush')`, a comparison
// with undefined, a truthiness test, and the value itself. A server renderer
// asks its output stream for `flush` this way once per render. The answer
// must not depend on whether the stream was asked before, was written to
// through the untyped value, or was destroyed.
// (stream-subclass-member-questions.ts: classes of the program below the
// stream classes; stream-member-questions-worker.ts: several threads.)
import {Duplex, PassThrough, Readable, Transform, Writable} from 'node:stream';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function show(value: unknown): string {
  if (typeof value === 'function') return 'function';
  return typeof value + ':' + String(value);
}

function makeWritable(): Writable {
  return new Writable({
    write(_chunk: Uint8Array | string, _encoding: string, callback: () => void) {
      callback();
    },
  });
}

function makeReadable(): Readable {
  return new Readable({read() {}});
}

function makeDuplex(): Duplex {
  return new Duplex({
    read() {},
    write(_chunk: Uint8Array | string, _encoding: string, callback: () => void) {
      callback();
    },
  });
}

function makeTransform(): Transform {
  return new Transform({
    transform(chunk: Uint8Array | string, _encoding: string, callback: () => void) {
      this.push(chunk);
      callback();
    },
  });
}

// A name no stream has, by every form.
function flush(tag: string, h: unknown): void {
  if (!isObject(h)) return;
  console.log(tag, 'flush', typeof h.flush, 'flush' in h, Reflect.has(h, 'flush'), h.flush === undefined, h.flush ? 'yes' : 'no', h.flush === h.flush, show(h.flush));
}

// Other names no stream has.
function absent(tag: string, h: unknown): void {
  if (!isObject(h)) return;
  console.log(tag, 'absent', typeof h.flushHeaders, 'flushHeaders' in h, typeof h.x, 'x' in h, typeof h.Write, Reflect.has(h, 'writ'), show(h.destroyedAt));
}

// A name that is absent until the program stores it.
function custom(tag: string, h: unknown): void {
  if (!isObject(h)) return;
  console.log(tag, 'custom', typeof h.custom, 'custom' in h, Reflect.has(h, 'custom'), show(h.custom));
}

// A method of every stream, by every form.
function on(tag: string, h: unknown): void {
  if (!isObject(h)) return;
  console.log(tag, 'on', typeof h.on, 'on' in h, Reflect.has(h, 'on'), h.on === undefined, h.on ? 'yes' : 'no', h.on === h.on, show(h.on));
}

// Other members of every stream.
function common(tag: string, h: unknown): void {
  if (!isObject(h)) return;
  console.log(tag, 'common', typeof h.pipe, 'pipe' in h, typeof h.destroy, Reflect.has(h, 'destroy'), typeof h.destroyed, 'destroyed' in h, show(h.destroyed), show(h.closed));
}

// Members of a stream that can be written to.
function writableSide(tag: string, h: unknown): void {
  if (!isObject(h)) return;
  console.log(tag, 'write', typeof h.write, 'write' in h, Reflect.has(h, 'write'), h.write === h.write, typeof h.end, 'end' in h);
  console.log(tag, 'writable', typeof h.writable, 'writable' in h, Reflect.has(h, 'writable'), show(h.writable), show(h.writableLength), show(h.writableEnded));
}

// Members of a stream that can be read from.
function readableSide(tag: string, h: unknown): void {
  if (!isObject(h)) return;
  console.log(tag, 'read', typeof h.read, 'read' in h, Reflect.has(h, 'read'), h.read === h.read, typeof h.pause, 'pause' in h);
  console.log(tag, 'readable', typeof h.readable, 'readable' in h, show(h.readable), show(h.readableLength), typeof h.readableFlowing, 'readableFlowing' in h, show(h.readableFlowing));
}

// Names every object inherits.
function inherited(tag: string, h: unknown): void {
  if (!isObject(h)) return;
  console.log(tag, 'inherited', typeof h.hasOwnProperty, 'hasOwnProperty' in h, typeof h.toString, Reflect.has(h, 'toString'));
}

// The same questions with names the compiler does not see: absent names and
// data properties by every form, methods by their presence.
function computed(tag: string, h: unknown, names: string[]): void {
  if (!isObject(h)) return;
  for (const name of names) {
    console.log(tag, 'computed', name, typeof h[name], name in h, Reflect.has(h, name), h[name] === undefined, h[name] === h[name]);
  }
}
function present(tag: string, h: unknown, names: string[]): void {
  if (!isObject(h)) return;
  for (const name of names) console.log(tag, 'present', name, name in h, Reflect.has(h, name));
}

const absentNames = ['flush', 'flushHeaders', 'x', '', 'writ', 'writeX', 'Write', 'readableX', 'destroyedAt'];
const commonNames = ['destroyed', 'closed'];
const commonMethods = [
  'on', 'once', 'addListener', 'prependListener', 'prependOnceListener', 'off', 'removeListener',
  'removeAllListeners', 'listenerCount', 'eventNames', 'pipe', 'destroy',
];
const writableNames = [
  'writable', 'writableEnded', 'writableFinished', 'writableLength', 'writableHighWaterMark',
  'writableNeedDrain',
];
const writableMethods = ['write', 'end', 'cork', 'uncork', 'setDefaultEncoding'];
const readableNames = ['readable', 'readableEnded', 'readableLength', 'readableHighWaterMark'];
const readableMethods = ['read', 'push', 'unshift', 'pause', 'resume', 'isPaused', 'setEncoding', 'unpipe'];

function everyStream(tag: string, h: unknown): void {
  flush(tag, h);
  absent(tag, h);
  custom(tag, h);
  on(tag, h);
  common(tag, h);
  inherited(tag, h);
  computed(tag, h, absentNames);
  computed(tag, h, commonNames);
  present(tag, h, commonMethods);
}

function writableQuestions(tag: string, h: unknown): void {
  everyStream(tag, h);
  writableSide(tag, h);
  computed(tag, h, writableNames);
  present(tag, h, writableMethods);
}

function readableQuestions(tag: string, h: unknown): void {
  everyStream(tag, h);
  readableSide(tag, h);
  computed(tag, h, readableNames);
  present(tag, h, readableMethods);
}

function duplexQuestions(tag: string, h: unknown): void {
  writableQuestions(tag, h);
  readableSide(tag, h);
  computed(tag, h, readableNames);
  present(tag, h, readableMethods);
}

// A stream that was never asked before answers each question on its own.
writableQuestions('Writable', makeWritable());
readableQuestions('Readable', makeReadable());
duplexQuestions('Duplex', makeDuplex());
duplexQuestions('Transform', makeTransform());
duplexQuestions('PassThrough', new PassThrough());

// The first question alone, on a stream nothing else was asked of.
function hasFlush(h: unknown): boolean {
  return isObject(h) && typeof h.flush === 'function';
}
function flushIn(h: unknown): boolean {
  return isObject(h) && 'flush' in h;
}
console.log('first', hasFlush(makeWritable()), hasFlush(makeReadable()), hasFlush(makeDuplex()), hasFlush(makeTransform()), hasFlush(new PassThrough()));
console.log('first in', flushIn(makeWritable()), flushIn(makeReadable()), flushIn(makeDuplex()), flushIn(makeTransform()), flushIn(new PassThrough()));

// One stream asked again and again, and asked after its method values were read.
const again: unknown = new PassThrough();
for (let round = 0; round < 3; round++) console.log('again', round, hasFlush(again), flushIn(again));
duplexQuestions('asked before', again);
console.log('again after', hasFlush(again), flushIn(again));

// An own property stored through the untyped value, then the questions.
function stored(tag: string, h: unknown): void {
  if (!isObject(h)) return;
  flush(tag + ' before', h);
  custom(tag + ' before', h);
  h.custom = 1;
  custom(tag + ' stored', h);
  flush(tag + ' stored', h);
  absent(tag + ' stored', h);
  on(tag + ' stored', h);
  common(tag + ' stored', h);
  h.flush = 'now';
  flush(tag + ' flush stored', h);
  h.custom = undefined;
  custom(tag + ' undefined', h);
}
stored('Writable', makeWritable());
stored('Readable', makeReadable());
stored('PassThrough', new PassThrough());

// A method the program replaces through the untyped value.
function replaced(tag: string, h: unknown): void {
  if (!isObject(h)) return;
  console.log(tag, 'before', typeof h.destroy, 'destroy' in h, hasFlush(h));
  h.destroy = function (): string {
    return 'replaced';
  };
  const destroy = h.destroy;
  console.log(tag, 'after', typeof h.destroy, 'destroy' in h, Reflect.has(h, 'destroy'), h.destroy === destroy, hasFlush(h), flushIn(h));
  if (typeof destroy === 'function') console.log(tag, 'call', String(destroy.call(h)));
  h.pipe = 5;
  console.log(tag, 'pipe', typeof h.pipe, 'pipe' in h, show(h.pipe));
  flush(tag + ' replaced', h);
  on(tag + ' replaced', h);
}
replaced('Writable', makeWritable());
replaced('Transform', makeTransform());

// A method read as a value and called on the stream it came from.
const chunks: string[] = [];
const sink = new Writable({
  write(chunk: Uint8Array | string, _encoding: string, callback: () => void) {
    chunks.push(String(chunk));
    callback();
  },
});
sink.on('finish', () => console.log('finished', chunks.join(',')));
const untypedSink: unknown = sink;
if (isObject(untypedSink)) {
  console.log('sink first', hasFlush(untypedSink), flushIn(untypedSink));
  const write = untypedSink.write;
  if (typeof write === 'function') console.log('write.call', String(write.call(untypedSink, 'a')));
  console.log('sink between', hasFlush(untypedSink), flushIn(untypedSink), typeof untypedSink.write);
  const writeAgain = untypedSink.write;
  if (typeof writeAgain === 'function') console.log('write.call again', String(writeAgain.call(untypedSink, 'b')), write === writeAgain);
  const end = untypedSink.end;
  if (typeof end === 'function') end.call(untypedSink);
  console.log('sink ended', hasFlush(untypedSink), flushIn(untypedSink), show(untypedSink.writableEnded));
}

// A destroyed stream, asked before and after.
const doomed = new PassThrough();
const untypedDoomed: unknown = doomed;
flush('doomed live', untypedDoomed);
common('doomed live', untypedDoomed);
doomed.destroy();
flush('doomed', untypedDoomed);
common('doomed', untypedDoomed);
const neverAsked = makeWritable();
neverAsked.destroy();
writableQuestions('destroyed Writable', neverAsked);
const goneReadable = makeReadable();
goneReadable.destroy();
readableQuestions('destroyed Readable', goneReadable);
