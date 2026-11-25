// node:stream's utility predicates over values that are not node streams or
// web streams: Node's duck typing reads the properties the value carries, so
// a primitive answers null/false, a plain object answers through the state
// members it happens to carry, and a property read that throws propagates.
// The same program pins the state each stream class reports in every phase of
// its life, and the side a class does not have.
import * as stream from "node:stream";
import { Duplex, PassThrough, Readable, Transform, Writable } from "node:stream";

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function flags(value: unknown): string {
  return [
    stream.isDestroyed(value),
    stream.isErrored(value),
    stream.isDisturbed(value),
    stream.isReadable(value),
    stream.isWritable(value),
    Readable.isDisturbed(value),
  ]
    .map((answer) => String(answer))
    .join(" ");
}

function attempt(label: string, read: () => unknown): void {
  try {
    console.log(label, String(read()));
  } catch (error) {
    const e = error as Error;
    console.log(label, "throws", e.name + ":" + e.message);
  }
}

const writeAndOn = { write() {}, on() {} };
const pipeAndOn = { pipe() {}, on() {} };

async function main(): Promise<void> {
  // Primitives and plain values: none of the properties Node reads.
  {
    const values: [string, unknown][] = [
      ["undefined", undefined],
      ["null", null],
      ["false", false],
      ["true", true],
      ["zero", 0],
      ["number", 3],
      ["nan", Number.NaN],
      ["empty-string", ""],
      ["string", "text"],
      ["bigint", 10n],
      ["symbol", Symbol("s")],
      ["array", [1, 2]],
      ["function", () => 1],
      ["promise", Promise.resolve(1)],
      ["plain", {}],
      ["error", new Error("e")],
      ["map", new Map([["a", 1]])],
    ];
    for (const [label, value] of values) console.log(label, flags(value));
  }

  // Objects that carry the members Node reads: a node stream is one with a
  // state object, or write/pipe beside on. Their absent state members answer
  // false, and a side without a boolean answers null.
  {
    const values: [string, unknown][] = [
      ["write+on", writeAndOn],
      ["pipe+on", pipeAndOn],
      ["write+pipe+on", { write() {}, pipe() {}, on() {} }],
      ["destroyed-true", { write() {}, on() {}, destroyed: true }],
      ["destroyed-false", { write() {}, on() {}, destroyed: false }],
      ["state-destroyed", { _readableState: { destroyed: true } }],
      ["state-not-destroyed", { _readableState: { destroyed: false } }],
      ["writable-state-destroyed", { _writableState: { destroyed: true } }],
      ["flags-true", { pipe() {}, on() {}, readable: true, writable: true }],
      ["flags-false", { pipe() {}, on() {}, readable: false, writable: false }],
      ["flags-nonboolean", { pipe() {}, on() {}, readable: 1, writable: "yes" }],
      ["readable-true-no-pipe", { readable: true }],
      ["readable-errored", { pipe() {}, on() {}, readable: true, readableErrored: new Error("r") }],
      ["readable-errored-null", { pipe() {}, on() {}, readable: true, readableErrored: null }],
      ["readable-errored-zero", { pipe() {}, on() {}, readable: true, readableErrored: 0 }],
      ["errored-plain", { destroyed: true, errored: new Error("e") }],
      ["readable-ended", { pipe() {}, on() {}, readable: true, readableEnded: true }],
      ["state-end-emitted", { pipe() {}, on() {}, readable: true, _readableState: { endEmitted: true } }],
      ["state-end-unemitted", { pipe() {}, on() {}, readable: true, _readableState: { endEmitted: false } }],
      ["state-end-nonboolean", { pipe() {}, on() {}, readable: true, _readableState: { endEmitted: "no" } }],
      ["state-errored", { pipe() {}, on() {}, readable: true, _readableState: { errored: new Error("s") } }],
      ["state-error-emitted", { _readableState: { errorEmitted: true } }],
      ["writable-ended", { write() {}, on() {}, writable: true, writableEnded: true }],
      ["writable-ending", { write() {}, on() {}, writable: true, writableEnded: false }],
      ["writable-state-ended", { write() {}, on() {}, writable: true, _writableState: { ended: true } }],
      ["writable-state-unended", { write() {}, on() {}, writable: true, _writableState: { ended: false } }],
      ["writable-state-nonboolean", { write() {}, on() {}, writable: true, _writableState: { ended: 1 } }],
      ["writable-state-errored", { write() {}, on() {}, writable: true, _writableState: { errored: new Error("w") } }],
      ["writable-errored-null", { write() {}, on() {}, writable: true, writableErrored: null }],
      ["both-errored", { write() {}, on() {}, readableErrored: null, writableErrored: new Error("w") }],
      ["did-read", { readableDidRead: true }],
      ["aborted", { readableAborted: true }],
      ["did-read-false-aborted", { readableDidRead: false, readableAborted: true }],
      ["duplex-shape", { write() {}, pipe() {}, on() {}, _readableState: { readable: false }, _writableState: {} }],
      ["duplex-readable-true", { write() {}, pipe() {}, on() {}, _readableState: { readable: true }, _writableState: {} }],
      ["readable-shaped-written", { write() {}, pipe() {}, on() {}, _writableState: {}, readable: true }],
    ];
    for (const [label, value] of values) console.log(label, flags(value));
  }

  // A property read that throws propagates from the predicate that makes it.
  {
    const destroying: unknown = {
      write() {},
      on() {},
      get destroyed(): boolean {
        throw new Error("destroyed boom");
      },
    };
    attempt("throw destroyed", () => stream.isDestroyed(destroying));
    // isReadable answers null for the value before it asks isDestroyed,
    // because it has no boolean `readable` member.
    attempt("readable without a flag", () => stream.isReadable(destroying));

    const reading: unknown = {
      on() {},
      pipe() {},
      get readable(): boolean {
        throw new Error("readable boom");
      },
    };
    attempt("throw readable", () => stream.isReadable(reading));

    const writing: unknown = {
      write() {},
      on() {},
      get writable(): boolean {
        throw new Error("writable boom");
      },
    };
    attempt("throw writable", () => stream.isWritable(writing));

    const disturbing: unknown = {
      get readableDidRead(): boolean {
        throw new Error("did-read boom");
      },
    };
    attempt("throw disturbed", () => stream.isDisturbed(disturbing));
    attempt("throw disturbed sideless", () => Readable.isDisturbed(disturbing));

    const erroring: unknown = {
      get readableErrored(): Error {
        throw new Error("errored boom");
      },
    };
    attempt("throw errored", () => stream.isErrored(erroring));
  }

  // isErrored reads each state only when its turn comes, and each state
  // property once per test it appears in: a state getter a later turn would
  // read is never touched once an earlier member answers.
  {
    const emitted: unknown = {
      _readableState: { errorEmitted: true },
      get _writableState(): unknown {
        throw new Error("writable state read");
      },
    };
    attempt("errored answered before the writable state", () => stream.isErrored(emitted));

    const lateThrow: unknown = {
      _readableState: { errorEmitted: undefined, errored: undefined },
      get _writableState(): unknown {
        throw new Error("writable state read");
      },
    };
    attempt("errored reads the writable state", () => stream.isErrored(lateThrow));

    const falsy: unknown = {
      _readableState: { errorEmitted: 0, errored: true },
      get _writableState(): unknown {
        throw new Error("writable state read");
      },
    };
    attempt("errored stops at a falsy errorEmitted", () => stream.isErrored(falsy));

    let readableReads = 0;
    let writableReads = 0;
    const counted: unknown = {
      get _readableState() {
        readableReads += 1;
        return {};
      },
      get _writableState() {
        writableReads += 1;
        return {};
      },
    };
    console.log("errored state reads", stream.isErrored(counted), readableReads, writableReads);

    const nullReadable: unknown = { _readableState: null, _writableState: { errored: 1 } };
    console.log("errored null readable", stream.isErrored(nullReadable));
  }

  // Node streams report their state through the same predicates: a readable
  // is not readable once it ends or is destroyed, a writable once it finishes,
  // and a transform's readable side follows the writable side's end.
  {
    const readable = Readable.from(["a", "b"]);
    console.log("readable fresh", flags(readable));
    readable.on("data", () => {});
    await turn();
    await turn();
    console.log("readable ended", flags(readable));
    await turn();
    console.log("readable closed", flags(readable));

    const destroyed = new PassThrough();
    destroyed.destroy();
    console.log("destroyed", flags(destroyed));

    const errored = new PassThrough();
    errored.on("error", () => {});
    errored.destroy(new Error("boom"));
    console.log("errored", flags(errored));

    const writable = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    console.log("writable fresh", flags(writable));
    writable.end("x");
    console.log("writable ending", flags(writable));
    await turn();
    await turn();
    console.log("writable finished", flags(writable));

    const duplex = new Duplex({ read() { this.push(null); }, write(_chunk, _encoding, callback) { callback(); } });
    console.log("duplex fresh", flags(duplex));
    duplex.destroy();
    console.log("duplex destroyed", flags(duplex));

    const transform = new Transform({ transform(chunk, _encoding, callback) { callback(null, chunk); } });
    console.log("transform fresh", flags(transform));
    transform.end("x");
    await turn();
    console.log("transform writing", flags(transform));
    transform.resume();
    await turn();
    await turn();
    console.log("transform done", flags(transform));
  }

  // A readable whose source throws reports the error through isErrored and
  // stays readable no longer.
  {
    async function* failing(): AsyncGenerator<string> {
      yield "a";
      throw new Error("iter boom");
    }
    const iterated = Readable.from(failing());
    iterated.on("error", () => {});
    iterated.on("data", () => {});
    await turn();
    await turn();
    console.log("iterated errored", flags(iterated));
  }

  // Untyped values holding each native class take the same answers.
  {
    const values: unknown[] = [
      new Readable({ read() {} }),
      new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } }),
      new PassThrough(),
    ];
    for (const value of values) console.log("untyped", flags(value));
  }
}

void main();
