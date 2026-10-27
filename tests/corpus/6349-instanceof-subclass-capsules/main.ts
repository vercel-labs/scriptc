// `instanceof` against a JavaScript class reads the prototype chain of a
// value that crossed into the dynamic tier at a base static type (here
// Error): the value is its exact class at runtime, including a subclass
// without methods of its own, which answers false rather than throwing.
import errors from "./errors.cjs";

function describe(err: unknown): string {
  if (err instanceof errors.UndiciError) return `undici ${err.name}`;
  if (err instanceof Error) return `error ${err.name}`;
  return "other";
}
function isSocket(err: unknown): boolean {
  return err instanceof errors.SocketError;
}
function fail(kind: number): Error {
  if (kind === 0) return new errors.HTTPParserError("bad chunk");
  if (kind === 1) return new errors.SocketError("closed");
  return new RangeError("range");
}
for (let kind = 0; kind < 3; kind++) {
  const err: Error = fail(kind);
  console.log(describe(err), isSocket(err));
}
const base: Error = new errors.UndiciError("base");
console.log(describe(base), isSocket(base));
const rejected = Promise.reject(fail(0));
rejected.catch((err: unknown) => console.log("rejected", describe(err)));
