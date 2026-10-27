// Builtin classes through const aliases: EventEmitter, the stream classes,
// the error classes, Map and Set construct, extend and test instanceof
// through an alias, and typeof, .name and === answer as in Node for the
// aliases and the direct spellings.
import { EventEmitter } from "node:events";
import * as events from "node:events";
import { PassThrough, Readable, Transform } from "node:stream";
import * as stream from "node:stream";
import { AssertionError } from "node:assert";
import * as assert from "node:assert";

function lateEmitter(): boolean {
  return new LateEmitter() instanceof EventEmitter && typeof LateMap === "function";
}

function localHoist(): string {
  function inner(): string {
    return `${typeof LocalMap} ${LocalMap.name} ${new LocalMap<string, number>().size}`;
  }
  const LocalMap = Map;
  return inner();
}

const Emitter = EventEmitter;
const NsEmitter = events.EventEmitter;
const Again = Emitter;
const LateEmitter = events.EventEmitter;
const LateMap = Map;

const e = new Emitter();
e.on("ping", (n: number) => console.log("ping", n));
e.emit("ping", 1);
console.log("emitter", e instanceof Emitter, e instanceof NsEmitter, e instanceof Again);
console.log("hoisted use", lateEmitter(), localHoist());

class Bus extends Again {
  send(text: string): void {
    this.emit("text", text);
  }
}
const bus = new Bus();
bus.on("text", (text: string) => console.log("bus", text));
bus.send("hello");
console.log("subclass", bus instanceof Emitter, bus instanceof Bus);

const Pass = PassThrough;
const R = Readable;
const T = stream.Transform;
const pass = new Pass();
console.log("stream", pass instanceof Pass, pass instanceof R, pass instanceof T);
console.log("readable", new R({ read() {} }) instanceof Pass, e instanceof R);

class Upper extends T {
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error: Error | null, data?: string) => void,
  ): void {
    callback(null, chunk.toString().toUpperCase());
  }
}
const upper = new Upper();
upper.on("data", (chunk: Buffer) => console.log("upper", chunk.toString()));
upper.end("quiet");

const TE = TypeError;
const RE = RangeError;
class LimitError extends RE {
  constructor(limit: number) {
    super(`over ${limit}`);
    this.name = "LimitError";
  }
}
try {
  throw new TE("bad input");
} catch (err) {
  console.log("error", err instanceof TE, err instanceof RE, err instanceof Error, (err as Error).message);
}
try {
  throw new LimitError(3);
} catch (err) {
  console.log("subclass error", err instanceof RE, err instanceof LimitError, (err as Error).message);
}
const AE = AssertionError;
try {
  assert.strictEqual(1, 2);
} catch (err) {
  console.log("assertion", err instanceof AE, err instanceof TE);
}
const viaNamespace = new assert.AssertionError({ message: "custom" });
console.log("namespace error", viaNamespace.message, viaNamespace instanceof AE);

const M = Map;
const S = Set;
const m = new M<string, number>([
  ["a", 1],
  ["b", 2],
]);
m.set("c", 3);
const s = new S([1, 2, 2, 3]);
console.log("collections", m.get("b"), m.size, s.size, m instanceof M, s instanceof S, s instanceof M);
const groups = M.groupBy([1, 2, 3, 4, 5], (n: number) => (n % 2 === 0 ? "even" : "odd"));
console.log("groupBy", groups.get("even"), groups.get("odd"));

console.log("typeof", typeof Emitter, typeof R, typeof TE, typeof M, typeof EventEmitter, typeof Readable);
console.log("name", Emitter.name, NsEmitter.name, Pass.name, T.name, TE.name, AE.name, M.name, S.name);
console.log("direct name", EventEmitter.name, stream.Duplex.name, Error.name, RangeError.name, Map.name, Set.name);
console.log("identity", Emitter === EventEmitter, Again === NsEmitter, T === Transform, R === stream.Readable);
console.log("other class", (Pass as unknown) === (R as unknown), (M as unknown) !== (S as unknown), (TE as unknown) === (RE as unknown));
