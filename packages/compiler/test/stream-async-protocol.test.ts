import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { lowerToIr, type LowerResult } from "../src/frontend/lowering/lowerer.js";
import { loadProgram } from "../src/frontend/program-node.js";
import { serializeModule } from "../src/ir/serialize.js";

// Which async-iteration protocol types hold a checked-dynamic value is a
// fact of the program (async-protocol-holders.ts), not of a lowering pass.
// A stream program's push-down pass can end where it asks for a stream mode
// (stream-flags-abort.test.ts), before it has seen the protocol spellings
// that follow; these fixtures pin that the stream pass maps them the same
// way whether or not the push-down pass ran to its end, and that no pass
// exists only to find out.

// Untyped pipeline stages and a Writable in a stdio-represented slot set
// both stream flags, as in stream-flags-abort.test.ts.
const STREAM = `
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

// After the stream flow: a class implementing the protocol in an
// AsyncIterable<T> slot, which makes AsyncIterable<number> hold the
// checked-dynamic value.
const PROTOCOL = `
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

// After the stream flow: only compiled async generators reach the slot, so
// it stays a generator slot.
const GENERATORS = `
async function* doubling(limit: number): AsyncIterableIterator<number> {
  for (let n = 1; n <= limit; n++) yield n * 2;
}
async function sum(source: AsyncIterable<number>): Promise<number> {
  let total = 0;
  for await (const n of source) total += n;
  return total;
}
sum(doubling(3)).then((total) => console.log("sum", total));
`;

interface Phase {
  phase: string;
  aborted?: string;
}

interface Lowering {
  result: LowerResult;
  phases: Phase[];
}

let directory: string;
let protocol: ReturnType<typeof loadProgram>;
let generators: ReturnType<typeof loadProgram>;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "scriptc-stream-async-protocol-"));
  writeFileSync(join(directory, "protocol.ts"), STREAM + PROTOCOL);
  writeFileSync(join(directory, "generators.ts"), STREAM + GENERATORS);
  protocol = loadProgram(join(directory, "protocol.ts"));
  generators = loadProgram(join(directory, "generators.ts"));
});

afterAll(() => {
  protocol.dispose();
  generators.dispose();
  rmSync(directory, { recursive: true, force: true });
});

/** Lower one loaded program with the push-down abort on or off, collecting
 * the lowering's phase records (SCRIPTC_TIMING). */
function lower(load: ReturnType<typeof loadProgram>, abortOnStreamFlags: boolean): Lowering {
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
      abortOnStreamFlags,
    });
    const phases = lines
      .filter((line) => line.startsWith("scriptc lowering "))
      .map((line) => JSON.parse(line.slice("scriptc lowering ".length)) as Phase);
    return { result, phases };
  } finally {
    process.stderr.write = stderr;
    if (previous === undefined) delete process.env["SCRIPTC_TIMING"];
    else process.env["SCRIPTC_TIMING"] = previous;
  }
}

/** The decision-bearing part of a lowering result, without the push-down
 * pass, which is the one phase the abort is allowed to change. */
function outcome({ result, phases }: Lowering): unknown {
  return {
    module: result.module === null ? null : serializeModule(result.module, true),
    diagnostics: result.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      loc: diagnostic.loc,
    })),
    passes: phases.map((phase) => phase.phase),
  };
}

/** The passes that lower the program, without the scans that follow them. */
const passes = ({ phases }: Lowering): string[] => {
  const names = phases.map((phase) => phase.phase);
  return names.slice(0, names.indexOf("async-protocol-flows") + 1);
};
/** A stream program's passes: the push-down pass, the stream pass, and the
 * line that says the protocol analysis ran. No pass decides the protocol. */
const PASSES = ["ffi-validate", "reachable-emit", "dyn-streams-relower", "async-protocol-flows"];

/** The IR type of `sum`'s parameter. */
function sumParameter({ result }: Lowering): string | undefined {
  return result.module?.functions.find((fn) => fn.name === "sum")?.params[0]?.type.kind;
}

test("a stream program holds an implementor after an aborted push-down pass", () => {
  const full = lower(protocol, false);
  const aborted = lower(protocol, true);
  expect(full.phases.find((phase) => phase.phase === "reachable-emit")?.aborted).toBeUndefined();
  expect(aborted.phases.find((phase) => phase.phase === "reachable-emit")?.aborted).toBe(
    "stream-flags",
  );
  // The stream pass holds the class in a checked-dynamic slot; no further
  // pass decides it.
  expect(passes(full)).not.toContain("dyn-async-protocol-relower");
  expect(passes(aborted)).toEqual(PASSES);
  expect(aborted.result.diagnostics).toEqual([]);
  expect(aborted.result.module).not.toBeNull();
  expect(sumParameter(aborted)).toBe("dyn");
  expect(outcome(aborted)).toEqual(outcome(full));
});

test("a stream program of compiled generators keeps its generator slots", () => {
  const full = lower(generators, false);
  const aborted = lower(generators, true);
  expect(aborted.phases.find((phase) => phase.phase === "reachable-emit")?.aborted).toBe(
    "stream-flags",
  );
  expect(passes(aborted)).toEqual(PASSES);
  expect(aborted.result.diagnostics).toEqual([]);
  expect(sumParameter(aborted)).toBe("generator");
  expect(outcome(aborted)).toEqual(outcome(full));
});
