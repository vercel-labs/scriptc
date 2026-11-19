// stream.getDefaultHighWaterMark / setDefaultHighWaterMark: the per-isolate
// defaults every stream built afterwards takes (Node's state.js module
// state), the byte-mode/object-mode split, construction across the five
// classes (objectMode sides take the object default, an explicit option
// wins), streams built BEFORE a set keeping their value, and the setter's
// validateInteger(value, 'value', 0) errors — a non-integer or out-of-range
// number is ERR_OUT_OF_RANGE with Node's exact text. A non-number argument
// has no static spelling (the declaration types it number); the JavaScript
// companion stream-default-high-water-mark-errors.cjs tests that ladder.
import {
  Duplex,
  PassThrough,
  Readable,
  Transform,
  Writable,
  getDefaultHighWaterMark,
  setDefaultHighWaterMark,
} from "node:stream";

function show(label: string, f: () => void): void {
  try {
    f();
    console.log(label, "ok");
  } catch (e) {
    const error = e as NodeJS.ErrnoException;
    console.log(label, "->", error.name, error.code, JSON.stringify(error.message));
  }
}

console.log("initial", getDefaultHighWaterMark(false), getDefaultHighWaterMark(true));

setDefaultHighWaterMark(false, 1024);
console.log("bytes now", getDefaultHighWaterMark(false));

const readable = new Readable({ read() {} });
console.log("readable", readable.readableHighWaterMark);
const writable = new Writable({ write(_c, _e, cb) { cb(); } });
console.log("writable", writable.writableHighWaterMark);
const duplex = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
console.log("duplex", duplex.readableHighWaterMark, duplex.writableHighWaterMark);
const transform = new Transform({ transform(c, _e, cb) { cb(null, c); } });
console.log("transform", transform.readableHighWaterMark, transform.writableHighWaterMark);
const passthrough = new PassThrough();
console.log("passthrough", passthrough.readableHighWaterMark, passthrough.writableHighWaterMark);

// Object-mode sides keep the object default; a mixed transform takes each
// side's own default.
const objectReadable = new Readable({ objectMode: true, read() {} });
console.log("readable objectMode", objectReadable.readableHighWaterMark);
const objectDuplex = new Duplex({ objectMode: true, read() {}, write(_c, _e, cb) { cb(); } });
console.log("duplex objectMode", objectDuplex.readableHighWaterMark, objectDuplex.writableHighWaterMark);
const halfObject = new Transform({
  readableObjectMode: true,
  transform(c, _e, cb) { cb(null, c); },
});
console.log("transform readableObjectMode", halfObject.readableHighWaterMark, halfObject.writableHighWaterMark);

// Options beat the defaults.
const explicit = new Readable({ highWaterMark: 7, read() {} });
console.log("explicit", explicit.readableHighWaterMark);
const sided = new Duplex({
  readableHighWaterMark: 3,
  writableHighWaterMark: 5,
  read() {},
  write(_c, _e, cb) { cb(); },
});
console.log("sided", sided.readableHighWaterMark, sided.writableHighWaterMark);
// Readable.from's own rule (1 for an iterable) is not a default.
const fromArray = Readable.from(["a", "b"]);
console.log("from array", fromArray.readableHighWaterMark, fromArray.readableObjectMode);

// The object default moves independently, and earlier streams keep theirs.
setDefaultHighWaterMark(true, 32);
console.log("object now", getDefaultHighWaterMark(true));
const objectAfter = new Readable({ objectMode: true, read() {} });
console.log("readable objectMode after", objectAfter.readableHighWaterMark, objectReadable.readableHighWaterMark);
console.log("bytes unchanged", getDefaultHighWaterMark(false), readable.readableHighWaterMark);

setDefaultHighWaterMark(true, 16);
setDefaultHighWaterMark(false, 65536);

// validateInteger(value, 'value', 0): a non-integer or out-of-range number
// is ERR_OUT_OF_RANGE with Node's exact text. A non-number argument has no
// static spelling (the declaration types it number); the JavaScript companion
// tests that ladder.
show("fraction", () => setDefaultHighWaterMark(false, 1.5));
show("negative", () => setDefaultHighWaterMark(false, -1));
show("beyond safe", () => setDefaultHighWaterMark(false, 9007199254740992));
show("nan", () => setDefaultHighWaterMark(true, NaN));
show("infinity", () => setDefaultHighWaterMark(false, Infinity));
console.log("after failures", getDefaultHighWaterMark(false), getDefaultHighWaterMark(true));

// 0 is a legal high-water mark.
show("zero", () => setDefaultHighWaterMark(false, 0));
const zero = new Readable({ read() {} });
console.log("zero stream", zero.readableHighWaterMark);
setDefaultHighWaterMark(false, 65536);

// A stream built from a web stream takes the object default too: the
// adapter constructs the Readable there, so the default is read then.
setDefaultHighWaterMark(true, 12);
const web = new ReadableStream({
  start(controller) {
    controller.close();
  },
});
const fromWeb = Readable.fromWeb(web, { objectMode: true });
console.log("fromWeb objectMode", fromWeb.readableHighWaterMark, fromWeb.readableObjectMode);
setDefaultHighWaterMark(true, 16);
