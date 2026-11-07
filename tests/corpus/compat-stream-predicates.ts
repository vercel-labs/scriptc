// node:stream's utility predicates from typed code: a stream typed as its
// class, as a base class, as a union of classes, and as `unknown`. A
// binding typed Readable can hold a Duplex, so the side questions are
// answered from the stream itself, not from the declared type.
import * as stream from "node:stream";
import { Duplex, PassThrough, Readable, Transform, Writable } from "node:stream";

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const noop = (_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void => callback();

function asReadable(value: Readable): string {
  return [
    stream.isDestroyed(value),
    stream.isErrored(value),
    stream.isDisturbed(value),
    stream.isReadable(value),
    stream.isWritable(value),
  ].join(" ");
}
function asWritable(value: Writable): string {
  return [
    stream.isDestroyed(value),
    stream.isErrored(value),
    stream.isDisturbed(value),
    stream.isReadable(value),
    stream.isWritable(value),
  ].join(" ");
}
function asEither(value: Readable | Writable): string {
  return [
    stream.isDestroyed(value),
    stream.isErrored(value),
    stream.isDisturbed(value),
    stream.isReadable(value),
    stream.isWritable(value),
  ].join(" ");
}
function asNullable(value: Readable | null): string {
  return [
    stream.isDestroyed(value),
    stream.isErrored(value),
    stream.isDisturbed(value),
    stream.isReadable(value),
    stream.isWritable(value),
  ].join(" ");
}
function asUnknown(value: unknown): string {
  return [
    stream.isDestroyed(value),
    stream.isErrored(value),
    stream.isDisturbed(value),
    stream.isReadable(value),
    stream.isWritable(value),
  ].join(" ");
}

async function main(): Promise<void> {
  // Readable.
  const readable = Readable.from(["a", "b"]);
  const fresh: boolean | null = stream.isReadable(readable);
  console.log("readable new", fresh, stream.isWritable(readable), stream.isDisturbed(readable));
  console.log("readable new", asReadable(readable), "|", asEither(readable), "|", asUnknown(readable));
  readable.on("data", () => {});
  await turn();
  await turn();
  console.log("readable closed", stream.isDestroyed(readable), stream.isReadable(readable), Readable.isDisturbed(readable));
  console.log("readable closed", asReadable(readable), "|", asEither(readable), "|", asUnknown(readable));

  console.log("nullable", asNullable(readable), "|", asNullable(null));

  // Writable.
  const writable = new Writable({ write: noop });
  console.log("writable new", stream.isReadable(writable), stream.isWritable(writable), stream.isDisturbed(writable));
  console.log("writable new", asWritable(writable), "|", asEither(writable), "|", asUnknown(writable));
  writable.end("x");
  console.log("writable ended", asWritable(writable), "|", asUnknown(writable));
  await turn();
  console.log("writable closed", asWritable(writable), "|", asEither(writable));

  // A PassThrough seen as its Readable base, in a union and untyped.
  const through = new PassThrough();
  console.log("through", asReadable(through), "|", asEither(through), "|", asUnknown(through));
  through.end("x");
  console.log("through ended", asReadable(through), "|", asEither(through));
  through.resume();
  await turn();
  console.log("through closed", asReadable(through), "|", asEither(through), "|", asUnknown(through));

  // Duplex and Transform, and the inherited static.
  const duplex = new Duplex({ read() {}, write: noop });
  console.log("duplex", asReadable(duplex), Duplex.isDisturbed(duplex));
  duplex.destroy();
  console.log("duplex destroyed", asEither(duplex), Duplex.isDisturbed(duplex));
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, chunk);
    },
  });
  transform.write("x");
  transform.read();
  console.log("transform read", asReadable(transform), Transform.isDisturbed(transform));
  transform.destroy();

  // isErrored turns true with the 'error' event.
  const failing = new PassThrough();
  failing.on("error", (error) => console.log("error event", error.message, stream.isErrored(failing)));
  failing.destroy(new Error("boom"));
  console.log("after destroy(err)", stream.isErrored(failing), stream.isDestroyed(failing));
  await turn();
  console.log("after error", stream.isErrored(failing), asUnknown(failing));

  // Primitives, including the bigint and symbol forms the checker knows.
  const values: unknown[] = [undefined, null, 0, "text", true, 7n, Symbol("s")];
  for (const value of values) console.log(typeof value, String(value), asUnknown(value));
  console.log("literal", stream.isDestroyed(null), stream.isErrored(undefined), stream.isDisturbed(1));
  console.log("literal", stream.isReadable("text"), stream.isWritable(false));
  console.log("literal", stream.isDestroyed(7n), stream.isErrored(7n), stream.isDisturbed(7n));
  console.log("literal", stream.isReadable(Symbol("r")), stream.isWritable(Symbol("w")));
}

main();
