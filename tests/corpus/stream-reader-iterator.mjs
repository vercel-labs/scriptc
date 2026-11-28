// readable.iterator([options]) and readable[Symbol.asyncIterator](): the
// runtime iterator object behind a readable's async iteration, held in a
// typed slot. next() answers { value, done }, the iterator is async-iterable
// itself, the symbol member answers a fresh iterator per call, and with
// { destroyOnReturn: false } a return() leaves the stream alive.
import { Readable, Duplex, Transform } from "node:stream";

const first = Readable.from(["a", "b"]).iterator();
const one = await first.next();
const two = await first.next();
const three = await first.next();
console.log("next", String(one.value), one.done, String(two.value), two.done, String(three.value), three.done);

const collected = [];
for await (const chunk of Readable.from(["c", "d"]).iterator()) collected.push(String(chunk));
console.log("for-await", collected.join(","));

const kept = Readable.from(["e", "f", "g"]);
const handling = kept.iterator({ destroyOnReturn: false });
const head = await handling.next();
const returned = await handling.return();
console.log("return", String(head.value), returned.done, kept.destroyed, kept.readableAborted);

// The explicit well-known symbol member: a function on the stream that
// answers a fresh iterator per call, and a stream iterated through it.
const viaSymbol = Readable.from(["h", "i"]);
const symbolIterator = viaSymbol[Symbol.asyncIterator]();
const symbolHead = await symbolIterator.next();
const another = viaSymbol[Symbol.asyncIterator]();
console.log("symbol", String(symbolHead.value), typeof viaSymbol[Symbol.asyncIterator], another === symbolIterator);
const rest = [];
for await (const chunk of viaSymbol) rest.push(String(chunk));
console.log("symbol-rest", rest.join(","));

// The symbol member is the stream's own iterator, so a for-await opens it
// directly, and a Duplex or Transform answers it from the readable side.
const viaLoop = [];
for await (const chunk of Readable.from(["j", "k"])[Symbol.asyncIterator]()) viaLoop.push(String(chunk));
console.log("symbol-loop", viaLoop.join(","));

const duplex = new Duplex({ read() {}, write(chunk, encoding, callback) { callback(); } });
duplex.push("l");
duplex.push(null);
const duplexIterator = duplex[Symbol.asyncIterator]();
const duplexHead = await duplexIterator.next();
console.log("duplex", String(duplexHead.value), duplexHead.done);

const transform = new Transform({ transform(chunk, encoding, callback) { callback(null, chunk); } });
transform.end("m");
const transformIterator = transform[Symbol.asyncIterator]();
const transformHead = await transformIterator.next();
console.log("transform", String(transformHead.value), transformHead.done);

// next() then for-await on the same iterator keeps the position.
const mixed = Readable.from(["n", "o", "p"]);
const mixedIterator = mixed[Symbol.asyncIterator]();
const mixedFirst = await mixedIterator.next();
const mixedRest = [];
for await (const chunk of mixedIterator) mixedRest.push(String(chunk));
console.log("mixed", String(mixedFirst.value), mixedRest.join(","));
