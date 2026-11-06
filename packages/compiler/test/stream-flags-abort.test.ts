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

// WP2-2: a stream program's push-down pass exists only to learn its two
// stream flags — the stream pass replaces its reachable set, result,
// diagnostics, fences and Lowerer outright. These fixtures end that pass at
// its last flag and pin that the reported result is the one the full pass
// would produce.
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

// Only the general stream flag: a stream value reaching a slot the stdio
// handles represent, with no untyped pipeline stage. This pass must run to
// the end, because the abort is only exact once BOTH flags are set.
const GENERAL_ONLY = `
const { Readable } = require("node:stream");
declare const sink: NodeJS.WritableStream;
Readable.from(["a"]).pipe(sink);
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
  writeFileSync(join(directory, "plain.cjs"), `console.log("plain");\n`);
  compiling = loadProgram(join(directory, "stream.cjs"));
  refusing = loadProgram(join(directory, "stream-refused.cjs"));
});

afterAll(() => {
  compiling.dispose();
  refusing.dispose();
  rmSync(directory, { recursive: true, force: true });
});

/** Lower one loaded program with the push-down abort on or off, collecting
 * the lowering's phase records (SCRIPTC_TIMING). */
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
  // Both stream flags are set, so the pass ends at the last of them and the
  // stream pass replaces its result.
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

test("only the general stream flag keeps the full push-down pass", () => {
  const generalOnly = loadProgram(join(directory, "general-only.ts"));
  try {
    expect(pushDown(lower(generalOnly, true))?.aborted).toBeUndefined();
  } finally {
    generalOnly.dispose();
  }
});

test("a program without both stream flags keeps its full push-down pass", () => {
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
