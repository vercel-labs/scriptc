// A prepared island round decides its retry from one lowering pass
// (LowerOptions.stopAfterPushDown) instead of from the whole-slot and
// stream relowers. A program whose push-down pass needs the general stream
// representation is lowered again with it first, and that pass can compile
// a program whose push-down pass failed: deciding from the push-down pass
// alone would island packages from diagnostics the final pass never reports
// (a program that compiled then refuses with SC8020). So such a program is
// decided from the stream pass in push-down mode, and a stream pass that
// compiles is asked nothing.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { lowerToIr, type LowerOptions } from "../src/frontend/lowering/lowerer.js";
import { runFrontend } from "../src/frontend/pipeline.js";
import { loadProgram } from "../src/frontend/program-node.js";
import { serializeModule } from "../src/ir/serialize.js";

const corpus = join(import.meta.dirname, "../../../tests/corpus");

const STREAM_PROGRAMS = [
  "6466-node-stdio-stream-surface.ts",
  "6468-node-stdio-writable-slot.ts",
  "6467-node-stream-untyped-sources/main.ts",
];

test.for(STREAM_PROGRAMS)(
  "%s: a stream pass that compiles decides nothing, so the program keeps its islands",
  (file) => {
    const fe = runFrontend(join(corpus, file), loadProgram);
    try {
      const asked: string[] = [];
      const result = fe.lower({
        stopAfterPushDown: (r) => {
          asked.push(r.module === null ? "failed" : "compiled");
          return true;
        },
      });
      expect(result.module).not.toBeNull();
      // The stream relower compiled the program, so no pass's diagnostics
      // could retry: the predicate never sees a failed result.
      expect(asked).toEqual([]);
    } finally {
      fe.dispose();
    }
  },
  300_000,
);

// The push-down decision and the pass it reuses change only which pass
// reports an intermediate round's failure: the final lowering of a program
// must not change. A predicate that always declines is exactly the final
// round's path (run the full pipeline, reuse the stream pass push-down
// already produced).
test.for(STREAM_PROGRAMS)(
  "%s: declining the decision lowers the same program",
  (file) => {
    const once = (stop?: (r: { module: unknown }) => boolean) => {
      const fe = runFrontend(join(corpus, file), loadProgram);
      try {
        const result = fe.lower(stop === undefined ? {} : { stopAfterPushDown: stop });
        return {
          diagnostics: result.diagnostics.map((d) => `${d.code} ${d.message}`),
          module: result.module === null ? null : JSON.stringify(result.module),
        };
      } finally {
        fe.dispose();
      }
    };
    expect(once(() => false)).toEqual(once());
  },
  600_000,
);

// The passes of one lowering, in order, with the result they left: what a
// prepared round's retry decision changes and what it must leave alone.
interface Lowered {
  passes: string[];
  diagnostics: string[];
  fences: string[];
  module: string | null;
}

/** Writes `source` as a one-file program and hands `run` a function that
 * lowers it, collecting the lowering's pass records (SCRIPTC_TIMING). */
function withProgram(
  file: string,
  source: string,
  run: (lower: (options: LowerOptions) => Lowered) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-island-round-push-down-"));
  writeFileSync(join(directory, file), source);
  const load = loadProgram(join(directory, file));
  const lower = (options: LowerOptions): Lowered => {
    const previous = process.env["SCRIPTC_TIMING"];
    const stderr = process.stderr.write;
    const lines: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.env["SCRIPTC_TIMING"] = "1";
    try {
      const result = lowerToIr(load.program, load.entry, load.moduleOrder, {
        frontendServices: load.services,
        ...options,
      });
      const passes = lines
        .filter((line) => line.startsWith("scriptc lowering "))
        .map(
          (line) =>
            JSON.parse(line.slice("scriptc lowering ".length)) as {
              phase: string;
              aborted?: string;
            },
        )
        .filter(
          ({ phase }) =>
            phase === "reachable-emit" ||
            phase === "stop-after-push-down" ||
            phase.includes("relower"),
        )
        .map(({ phase, aborted }) => (aborted === undefined ? phase : `${phase} (${aborted})`));
      return {
        passes,
        diagnostics: result.diagnostics.map((d) => `${d.code} ${d.message}`),
        fences: result.runtimeFences.map((d) => `${d.code} ${d.message}`),
        module: result.module === null ? null : serializeModule(result.module, true),
      };
    } finally {
      process.stderr.write = stderr;
      if (previous === undefined) delete process.env["SCRIPTC_TIMING"];
      else process.env["SCRIPTC_TIMING"] = previous;
    }
  };
  try {
    run(lower);
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

// A stream program's push-down pass ends at its last stream flag
// (LowerOptions.abortOnStreamFlags) and leaves no result to decide from. A
// prepared round then decides from the stream pass, and the pipeline keeps
// that pass instead of lowering the program with streams a second time.
//
// Untyped pipeline stages and a Writable in a stdio-represented slot set
// both stream flags, which is what ends the push-down pass early.
const BOTH_STREAM_FLAGS = `
const { Readable, Writable, pipeline } = require("node:stream");
function run(source, destination) {
  pipeline(source, destination, (err) => {
    console.log(err ? "error" : "done");
  });
}
const sink = new Writable({
  write(chunk, _encoding, callback) {
    console.log("chunk", String(chunk));
    callback();
  },
});
run(Readable.from(["a", "b"]), sink);
`;

test("a push-down pass ended at its stream flags decides from the stream pass and reuses it", () => {
  withProgram("stream.cjs", BOTH_STREAM_FLAGS, (lower) => {
    const asked: string[] = [];
    const decided = lower({
      stopAfterPushDown: (r) => {
        asked.push(r.module === null ? "failed" : "compiled");
        return true;
      },
    });
    // The ended pass has no module, but it is not a failure to decide from:
    // the stream pass compiles the program, so the predicate is not asked.
    expect(asked).toEqual([]);
    // One stream pass, kept as the round's result.
    expect(decided.passes).toEqual([
      "reachable-emit (stream-flags)",
      "dyn-streams-relower",
      "stream-relower-reused",
    ]);
    expect(decided.module).not.toBeNull();
    // The program is the one the pipeline lowers without a predicate, and
    // the one it lowers when the push-down pass runs to its end.
    const plain = lower({});
    expect(plain.passes).toEqual(["reachable-emit (stream-flags)", "dyn-streams-relower"]);
    const full = lower({ abortOnStreamFlags: false, stopAfterPushDown: () => true });
    expect(full.passes).toEqual(["reachable-emit", "dyn-streams-relower"]);
    for (const other of [plain, full]) {
      expect(other.diagnostics).toEqual(decided.diagnostics);
      expect(other.fences).toEqual(decided.fences);
      expect(other.module).toEqual(decided.module);
    }
  });
}, 300_000);

// A stream program that still fails after its stream pass: a corpus program
// whose push-down pass needs the general stream representation, plus a class
// holding a field whose function type has no lowering. That type degrades in
// part, which is what the whole-slot comparison of a stream program judges.
const UNLOWERED_FIELD = `
class Holder {
  read = function () {
    return new.target;
  };
}
const holder = new Holder();
console.log(typeof holder.read);
`;

test("a failing stream program decides once, from its stream pass, and lowers with streams once", () => {
  const source = `${readFileSync(join(corpus, STREAM_PROGRAMS[1]!), "utf8")}\n${UNLOWERED_FIELD}`;
  withProgram("failing-stream.ts", source, (lower) => {
    // The push-down pass ends where it asks for the general representation.
    // A predicate that implies a retry ends the round at the stream pass:
    // the whole-slot comparison would only pick the pass a failure is
    // reported from, and the retry discards it.
    const asked: string[] = [];
    const retried = lower({
      stopAfterPushDown: (r) => {
        asked.push(r.module === null ? "failed" : "compiled");
        return true;
      },
    });
    expect(asked).toEqual(["failed"]);
    expect(retried.passes).toEqual([
      "reachable-emit (stream-flags)",
      "general-streams-relower",
      "stop-after-push-down",
    ]);
    expect(retried.module).toBeNull();
    expect(retried.diagnostics.length).toBeGreaterThan(0);
    // A predicate that declines is the final round: the stream pass it was
    // asked about is kept, and the whole-slot comparison runs on it. The
    // program is never lowered with streams a second time.
    const declined = lower({ stopAfterPushDown: () => false });
    expect(declined.passes).toEqual([
      "reachable-emit (stream-flags)",
      "general-streams-relower",
      "stream-relower-reused",
      "whole-slot-relower",
    ]);
    // It reports what the pipeline reports without a predicate.
    const plain = lower({});
    expect(plain.passes).toEqual([
      "reachable-emit (stream-flags)",
      "general-streams-relower",
      "whole-slot-relower",
    ]);
    expect(declined.diagnostics).toEqual(plain.diagnostics);
    expect(declined.fences).toEqual(plain.fences);
    expect(declined.module).toEqual(plain.module);
  });
}, 300_000);

// The async-iteration protocol relower (LowerOptions.dynAsyncProtocol) can
// compile a program whose earlier pass refused a class in an AsyncIterable<T>
// slot. A prepared round decides from the pass the pipeline reports, so the
// protocol relower runs before the predicate is asked: deciding from the
// refusing pass would island a dependency for a refusal the protocol slots
// clear.
const PROTOCOL_SLOT = `
class Counter implements AsyncIterable<number> {
  async *[Symbol.asyncIterator](): AsyncIterator<number> {
    yield 1;
    yield 2;
  }
}
async function sum(source: AsyncIterable<number>): Promise<number> {
  let total = 0;
  for await (const n of source) total += n;
  return total;
}
sum(new Counter()).then((total) => console.log("sum", total));
`;

// Both stream flags, typed: the push-down pass ends before it reaches the
// protocol spelling below it.
const TYPED_STREAM_FLAGS = `
import { Readable, Writable, pipeline } from "node:stream";
function run(source: any, destination: any): void {
  pipeline(source, destination, (err: unknown) => {
    console.log(err ? "error" : "done");
  });
}
const sink = new Writable({
  write(chunk: unknown, _encoding: string, callback: () => void) {
    console.log("chunk", String(chunk));
    callback();
  },
});
run(Readable.from(["a", "b"]), sink);
`;

test("a program the protocol relower compiles is not asked about its refusing pass", () => {
  withProgram("protocol.ts", PROTOCOL_SLOT, (lower) => {
    const asked: string[] = [];
    const decided = lower({
      stopAfterPushDown: (r) => {
        asked.push(r.module === null ? "failed" : "compiled");
        return true;
      },
    });
    expect(asked).toEqual([]);
    expect(decided.passes).toEqual(["reachable-emit", "dyn-async-protocol-relower"]);
    expect(decided.module).not.toBeNull();
    const plain = lower({});
    expect(plain.passes).toEqual(decided.passes);
    expect(plain.diagnostics).toEqual(decided.diagnostics);
    expect(plain.module).toEqual(decided.module);
  });
}, 300_000);

test("a stream program decides after its protocol relower and reuses that pass", () => {
  withProgram("stream-protocol.ts", TYPED_STREAM_FLAGS + PROTOCOL_SLOT, (lower) => {
    const asked: string[] = [];
    const decided = lower({
      stopAfterPushDown: (r) => {
        asked.push(r.module === null ? "failed" : "compiled");
        return true;
      },
    });
    // The stream pass refuses the class in the generator slot and the
    // protocol pass compiles it, so the round has no failure to decide from.
    expect(asked).toEqual([]);
    expect(decided.passes).toEqual([
      "reachable-emit (stream-flags)",
      "dyn-streams-relower",
      "dyn-async-protocol-relower",
      "stream-relower-reused",
    ]);
    expect(decided.module).not.toBeNull();
    // The same program as the pipeline without a predicate, which runs the
    // same stream and protocol passes once.
    const plain = lower({});
    expect(plain.passes).toEqual([
      "reachable-emit (stream-flags)",
      "dyn-streams-relower",
      "dyn-async-protocol-relower",
    ]);
    expect(plain.diagnostics).toEqual(decided.diagnostics);
    expect(plain.module).toEqual(decided.module);
  });
}, 300_000);
