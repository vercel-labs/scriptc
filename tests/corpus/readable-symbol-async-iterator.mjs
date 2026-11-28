// A compiled Readable answers [Symbol.asyncIterator] with the method Node's
// Readable.prototype has: the member is a function, and calling it returns
// the stream's async iterator, whose next() resolves the chunks.
import { Readable } from "node:stream";

const plain = Readable.from(["a", "b"]);
console.log("method", typeof plain[Symbol.asyncIterator]);
const first = await plain[Symbol.asyncIterator]().next();
console.log("first", String(first.value), first.done);
const second = await plain[Symbol.asyncIterator]().next();
console.log("second", String(second.value), second.done);
const third = await plain[Symbol.asyncIterator]().next();
console.log("third", String(third.value), third.done);
