import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  lowerToIr,
  type LowerOptions,
  type LowerResult,
} from "../src/frontend/lowering/lowerer.js";
import type { UnitStore } from "../src/frontend/lowering/unit-reuse.js";
import { loadProgram } from "../src/frontend/program-node.js";
import { serializeModule } from "../src/ir/serialize.js";

// A stream program's push-down pass exists only to learn the stream mode it
// asks for, and the general stream pass of a program that needs
// checked-dynamic stream slots only to ask for them — the pass that follows
// replaces the reachable set, result, diagnostics, fences and Lowerer
// outright. These fixtures end each such pass where it asks and pin that the
// reported result is the one the full passes produce.
//
// Lowering reports its refusals as runtime fences (a program that uses them
// keeps compiling and throws where it runs), so a refusing fixture is one
// with fences; the comparison below covers diagnostics, fences, IR and the
// pass order alike.

// Untyped pipeline stages and a Writable in a stdio-represented slot set
// both flags (the general and the checked-dynamic stream representations).
const STREAM = `
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

// The same stream flow plus a refusal: reading a Stats member as a value is
// fenced (SC1090), so the stream pass reports a fence the discarded
// push-down pass also found.
const STREAM_REFUSED = `
${STREAM}
const { statSync } = require("node:fs");
const stats = statSync(".");
const read = stats.isFile;
void read;
`;

// A Writable in a slot the stdio handles represent, written with types so
// that nothing is untyped.
const WRITABLE_IN_STDIO_SLOT = `
import { PassThrough, Readable, Writable, pipeline } from "node:stream";
function drain(source: Readable, sink: NodeJS.WritableStream): void {
  source.pipe(sink);
}
const sink = new Writable({
  write(chunk, _encoding, callback) {
    console.log("chunk", String(chunk));
    callback();
  },
});
drain(Readable.from(["a", "b"]), sink);
`;

// Only the general stream flag, with no untyped stream flow. The push-down
// pass ends at that flag and the general pass's result stands.
const GENERAL_ONLY = `
${WRITABLE_IN_STDIO_SLOT}
void PassThrough;
void pipeline;
`;

// The push-down pass asks for the general representation only, and the
// general pass asks for checked-dynamic slots: an untyped value reaches a
// slot that is a runtime stream class in both representations, which only
// the general pass counts.
const GENERAL_THEN_DYN = `
${WRITABLE_IN_STDIO_SLOT}
const loose: any = new PassThrough();
const through: PassThrough = loose;
through.end();
void pipeline;
`;

// The general flag in the module's own statements and an untyped pipeline
// stage in a function lowered after them: the push-down pass asks at the
// first, before it meets the second, and the general pass meets the
// untyped stage itself.
const GENERAL_BEFORE_UNTYPED = `
${WRITABLE_IN_STDIO_SLOT}
function relay(source: any, destination: any): void {
  pipeline(source, destination, (err: unknown) => {
    console.log(err ? "error" : "done");
  });
}
relay(Readable.from(["c"]), sink);
void PassThrough;
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
let compiling: ReturnType<typeof loadProgram>;
let refusing: ReturnType<typeof loadProgram>;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "scriptc-stream-flags-abort-"));
  writeFileSync(join(directory, "stream.cjs"), STREAM);
  writeFileSync(join(directory, "stream-refused.cjs"), STREAM_REFUSED);
  writeFileSync(join(directory, "general-only.ts"), GENERAL_ONLY);
  writeFileSync(join(directory, "general-then-dyn.ts"), GENERAL_THEN_DYN);
  writeFileSync(join(directory, "general-before-untyped.ts"), GENERAL_BEFORE_UNTYPED);
  writeFileSync(join(directory, "plain.cjs"), `console.log("plain");\n`);
  compiling = loadProgram(join(directory, "stream.cjs"));
  refusing = loadProgram(join(directory, "stream-refused.cjs"));
});

afterAll(() => {
  compiling.dispose();
  refusing.dispose();
  rmSync(directory, { recursive: true, force: true });
});

/** Lower one loaded program with the aborts on or off, collecting the
 * lowering's phase records (SCRIPTC_TIMING). */
function lower(
  load: ReturnType<typeof loadProgram>,
  abortOnStreamFlags: boolean,
  extra: LowerOptions = {},
): Lowering {
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
      ...extra,
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

/** The decision-bearing part of a lowering result: the IR, the reported
 * diagnostics and fences, and the pass order. */
function outcome({ result, phases }: Lowering): unknown {
  return {
    module: result.module === null ? null : serializeModule(result.module, true),
    diagnostics: result.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      loc: diagnostic.loc,
      moduleInit: diagnostic.moduleInit ?? false,
    })),
    runtimeFences: result.runtimeFences.map((fence) => ({
      code: fence.code,
      message: fence.message,
      loc: fence.loc,
    })),
    passes: phases.map((phase) => phase.phase),
  };
}

const pushDown = ({ phases }: Lowering): Phase | undefined =>
  phases.find((phase) => phase.phase === "reachable-emit");

/** The passes of a lowering, an aborted one marked. */
const passes = ({ phases }: Lowering): string[] =>
  phases
    .filter((phase) => phase.phase === "reachable-emit" || phase.phase.endsWith("-relower"))
    .map((phase) => (phase.aborted === undefined ? phase.phase : `${phase.phase} (aborted)`));

/** Both pipelines over one source file: every pass lowered to its end, and
 * each replaced pass ended where it asks for the next. */
function bothPipelines(file: string): { full: Lowering; aborted: Lowering } {
  const load = loadProgram(join(directory, file));
  try {
    return { full: lower(load, false), aborted: lower(load, true) };
  } finally {
    load.dispose();
  }
}

/** An in-memory unit store: opening one is what makes the push-down pass the
 * pass that records a build's units, so the abandon rule must leave it
 * alone. A first build into an empty store records no unit, which keeps the
 * comparison below about the abort. */
function memoryStore(): UnitStore {
  let writes = 0;
  return {
    readProgram: () => null,
    writeProgram: () => {},
    readFile: () => null,
    writeFile: () => `unit-${writes++}`,
  };
}

test("aborting a stream program's push-down pass leaves the result identical", () => {
  const full = lower(compiling, false);
  const aborted = lower(compiling, true);
  // Both stream flags are set at one site, so the pass ends there and asks
  // for the checked-dynamic stream pass at once.
  expect(pushDown(full)?.aborted).toBeUndefined();
  expect(pushDown(aborted)?.aborted).toBe("stream-flags");
  expect(aborted.phases.map((phase) => phase.phase)).toContain("dyn-streams-relower");
  expect(outcome(aborted)).toEqual(outcome(full));
});

test("aborting leaves a refusing stream program's fences and diagnostics identical", () => {
  const full = lower(refusing, false);
  const aborted = lower(refusing, true);
  expect(pushDown(full)?.aborted).toBeUndefined();
  expect(pushDown(aborted)?.aborted).toBe("stream-flags");
  // The discarded pass found the same refusal the reported result carries.
  expect(full.result.runtimeFences.length).toBeGreaterThan(0);
  expect(outcome(aborted)).toEqual(outcome(full));
});

test("the push-down pass ends at the general stream flag alone", () => {
  const { full, aborted } = bothPipelines("general-only.ts");
  expect(passes(full)).toEqual(["reachable-emit", "general-streams-relower"]);
  expect(passes(aborted)).toEqual(["reachable-emit (aborted)", "general-streams-relower"]);
  expect(outcome(aborted)).toEqual(outcome(full));
});

test("the general pass ends where it asks for checked-dynamic stream slots", () => {
  const { full, aborted } = bothPipelines("general-then-dyn.ts");
  expect(passes(full)).toEqual([
    "reachable-emit",
    "general-streams-relower",
    "dyn-streams-relower",
  ]);
  expect(passes(aborted)).toEqual([
    "reachable-emit (aborted)",
    "general-streams-relower (aborted)",
    "dyn-streams-relower",
  ]);
  expect(outcome(aborted)).toEqual(outcome(full));
});

test("an untyped stream flow after the general flag is the general pass's to find", () => {
  const { full, aborted } = bothPipelines("general-before-untyped.ts");
  // The push-down pass asks before it reaches the untyped stage, with the
  // aborts on or off, so both pipelines take the same three passes.
  expect(passes(full)).toEqual([
    "reachable-emit",
    "general-streams-relower",
    "dyn-streams-relower",
  ]);
  expect(passes(aborted)).toEqual([
    "reachable-emit (aborted)",
    "general-streams-relower (aborted)",
    "dyn-streams-relower",
  ]);
  expect(outcome(aborted)).toEqual(outcome(full));
});

test("a program without a stream flag keeps its full push-down pass", () => {
  const plain = loadProgram(join(directory, "plain.cjs"));
  try {
    expect(pushDown(lower(plain, true))?.aborted).toBeUndefined();
  } finally {
    plain.dispose();
  }
});

test("a unit store keeps the full push-down pass, which records its units", () => {
  // The push-down pass is the only pass that records units for reuse, so a
  // build that stores them never abandons it.
  const stored = lower(compiling, true, { unitStore: memoryStore() });
  expect(pushDown(stored)?.aborted).toBeUndefined();
});
