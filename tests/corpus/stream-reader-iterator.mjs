// readable.iterator([options]): the runtime iterator object behind a
// readable's async iteration, held in a typed slot. next() answers
// { value, done }, the iterator is async-iterable itself, and with
// { destroyOnReturn: false } a return() leaves the stream alive.
import { Readable } from "node:stream";

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
