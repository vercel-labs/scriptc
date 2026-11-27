// readable[Symbol.asyncIterator]() on a value the program does not type:
// the runtime stream view answers the member as Readable.prototype does, a
// fresh iterator per call, and its next()/for-await run the stream's own
// iterator. A declared Readable slot takes the same value.
import { Readable } from "node:stream";

const untyped: any = Readable.from(["u", "v"]);
const untypedIterator = untyped[Symbol.asyncIterator]();
const first = await untypedIterator.next();
console.log("untyped", String(first.value), typeof untyped[Symbol.asyncIterator]);
const rest: string[] = [];
for await (const chunk of untyped) rest.push(String(chunk));
console.log("untyped-rest", rest.join(","));

const declared: Readable = Readable.from(["w", "x", "y"]);
const declaredIterator: AsyncIterableIterator<any> = declared[Symbol.asyncIterator]();
const head = await declaredIterator.next();
const tail: string[] = [];
for await (const chunk of declaredIterator) tail.push(String(chunk));
console.log("declared", String(head.value), tail.join(","));
