// EventEmitter, the stream classes and the error classes as values:
// parameters, arrays, Map values and object fields hold the class, and
// construction, instanceof, typeof, .name and === through the value
// answer as in Node.
import { EventEmitter } from "node:events";
import { Duplex, PassThrough, Readable, Transform, Writable } from "node:stream";

function makeEmitter(C: typeof EventEmitter): EventEmitter {
  return new C();
}
const emitter = makeEmitter(EventEmitter);
emitter.on("ping", (n: number) => console.log("ping", n));
emitter.emit("ping", 1);
console.log("emitter", emitter instanceof EventEmitter);

const E: typeof EventEmitter = EventEmitter;
console.log("emitter value", typeof E, E.name, E === EventEmitter, new E() instanceof E);
const emitterKinds: (typeof EventEmitter)[] = [EventEmitter, PassThrough];
for (const Kind of emitterKinds) {
  const made = new Kind();
  console.log("emitter kind", Kind.name, made instanceof EventEmitter, made instanceof Readable);
}

const streamKinds: (typeof Readable)[] = [Readable, Duplex, Transform, PassThrough];
for (const Kind of streamKinds) {
  const stream = new Kind();
  console.log(
    "stream",
    Kind.name,
    stream instanceof Kind,
    stream instanceof Readable,
    stream instanceof Duplex,
    stream instanceof Writable,
  );
}

const W: typeof Writable = Writable;
const pass = new PassThrough();
console.log("writable value", pass instanceof W, new Readable() instanceof W, new W() instanceof W);

function writableKind(): typeof Writable {
  return Writable;
}
console.log("computed", pass instanceof writableKind(), new Readable() instanceof writableKind());

const mixedKinds = [Readable, Writable];
for (const Kind of mixedKinds) {
  const made = new Kind();
  console.log(
    "mixed",
    Kind.name,
    typeof Kind,
    made instanceof Kind,
    made instanceof EventEmitter,
    pass instanceof Kind,
  );
}
const emitterMix = [EventEmitter, Readable];
const SecondKind = emitterMix[1];
console.log("emitter mix", emitterMix[0] === EventEmitter, new SecondKind() instanceof Readable);

const readable = new Readable();
readable._read = () => {};
readable.on("data", (chunk: Buffer) => console.log("data", chunk.toString()));
readable.push("chunk");
readable.push(null);

const errorKinds: ErrorConstructor[] = [Error, TypeError, RangeError, SyntaxError];
for (const Kind of errorKinds) {
  const err = new Kind("failed", { cause: Kind.name });
  console.log(
    "error",
    Kind.name,
    err.name,
    err.message,
    err.cause,
    err instanceof Kind,
    err instanceof Error,
    err instanceof TypeError,
  );
}

function raise(Kind: ErrorConstructor, message: string): never {
  throw new Kind(message);
}
try {
  raise(RangeError, "out of range");
} catch (err) {
  console.log("caught", err instanceof RangeError, (err as Error).message, String(err));
}

const byName = new Map<string, ErrorConstructor>([
  ["type", TypeError],
  ["reference", ReferenceError],
]);
const ReferenceKind = byName.get("reference")!;
console.log("map value", ReferenceKind.name, new ReferenceKind() instanceof ReferenceError);

const registry: { stream: typeof Readable; error: ErrorConstructor } = {
  stream: Transform,
  error: URIError,
};
console.log(
  "fields",
  registry.stream.name,
  new registry.stream() instanceof Transform,
  new registry.error("bad uri").name,
);

const EmitterAlias = EventEmitter;
const aliasKinds = [EmitterAlias];
let mutableKind = EventEmitter;
console.log("aliases", aliasKinds.length, typeof mutableKind, mutableKind === EmitterAlias);

const sameClass = errorKinds[1] === TypeError;
const firstKind = streamKinds[0];
console.log("identity", sameClass, firstKind === Readable, firstKind === Duplex);
