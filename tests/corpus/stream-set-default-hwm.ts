// stream.setDefaultHighWaterMark changes the default a stream created after
// the call takes, in byte and object mode, for every constructor (an explicit
// highWaterMark still wins), and validates its value with ERR_OUT_OF_RANGE.
import {
  Duplex,
  PassThrough,
  Readable,
  Transform,
  Writable,
  getDefaultHighWaterMark,
  setDefaultHighWaterMark,
} from "node:stream";

const log: string[] = [];

function shape(label: string, fn: () => void): void {
  try {
    fn();
    log.push(`${label} no throw`);
  } catch (e: unknown) {
    const error = e as Error & { code?: string };
    log.push(`${label} ${e instanceof RangeError} ${error.code ?? "-"} ${error.message}`);
  }
}

log.push(`initial ${getDefaultHighWaterMark(false)} ${getDefaultHighWaterMark(true)}`);
const early = new Readable({ read(): void {} });
log.push(`early ${early.readableHighWaterMark}`);

setDefaultHighWaterMark(false, 1024);
setDefaultHighWaterMark(true, 3);
log.push(`after ${getDefaultHighWaterMark(false)} ${getDefaultHighWaterMark(true)}`);

const bytes = new Readable({ read(): void {} });
const objects = new Readable({ read(): void {}, objectMode: true });
const sink = new Writable({ write(chunk, encoding, done) { done(); } });
const objectSink = new Writable({ write(chunk, encoding, done) { done(); }, objectMode: true });
const transform = new Transform({ transform(chunk, encoding, done) { done(null, chunk); } });
const pass = new PassThrough();
const explicit = new Readable({ read(): void {}, highWaterMark: 7 });
log.push(`readable ${bytes.readableHighWaterMark} object ${objects.readableHighWaterMark}`);
log.push(`writable ${sink.writableHighWaterMark} object ${objectSink.writableHighWaterMark}`);
log.push(`transform ${transform.readableHighWaterMark}/${transform.writableHighWaterMark} pass ${pass.readableHighWaterMark}/${pass.writableHighWaterMark}`);
log.push(`explicit ${explicit.readableHighWaterMark} early still ${early.readableHighWaterMark}`);

// Duplex.from(promise) takes the object default; the async-function and
// iterable channels keep duplexify.js's own highWaterMark of 1. Every one of
// them keeps its object-mode state on both sides, as Node does.
const fromPromise = Duplex.from(Promise.resolve("p"));
log.push(`duplex promise ${fromPromise.readableObjectMode}/${fromPromise.writableObjectMode} ${fromPromise.readableHighWaterMark}/${fromPromise.writableHighWaterMark}`);
const fromAsync = Duplex.from(async function* () { yield "a"; });
log.push(`duplex asyncfn ${fromAsync.readableObjectMode}/${fromAsync.writableObjectMode} ${fromAsync.readableHighWaterMark}/${fromAsync.writableHighWaterMark}`);
const fromIterable = Duplex.from(["i"]);
log.push(`duplex iterable ${fromIterable.readableObjectMode}/${fromIterable.writableObjectMode} ${fromIterable.readableHighWaterMark}/${fromIterable.writableHighWaterMark}`);

shape("negative", () => setDefaultHighWaterMark(false, -1));
shape("fraction", () => setDefaultHighWaterMark(false, 1.5));
shape("nan", () => setDefaultHighWaterMark(true, NaN));
shape("max", () => setDefaultHighWaterMark(false, 9007199254740992));
log.push(`final ${getDefaultHighWaterMark(false)} ${getDefaultHighWaterMark(true)}`);
const last = new Readable({ read(): void {} });
log.push(`last ${last.readableHighWaterMark}`);

for (const line of log) console.log(line);
