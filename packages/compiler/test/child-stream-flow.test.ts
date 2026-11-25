import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { lowerToIr, type LowerResult } from "../src/frontend/lowering/lowerer.js";
import { loadProgram } from "../src/frontend/program-node.js";
import { moduleRuntimeFeatures } from "../src/ir/runtime-features.js";

// pause(), resume(), isPaused() and readableFlowing lower on the child stream
// handle, so a program that only pauses and resumes a child's output is not a
// stream program: it lowers once, in the push-down pass. A member the handle
// has no lowering for (here a 'close' listener on the stream) still asks for
// the general stream representation and the second pass, which is what shows
// that the first assertion can fail.

const FLOW = `
import { spawn } from "node:child_process";
const child = spawn("/bin/sh", ["-c", "printf hello"], { stdio: ["ignore", "pipe", "pipe"] });
child.stdout?.on("data", (chunk: Buffer) => {
  console.log(chunk.length);
});
child.on("exit", () => {
  child.stdout?.pause();
  child.stderr?.pause();
  const out = child.stdout;
  if (out) {
    console.log(out.isPaused(), out.readableFlowing);
    out.resume();
  }
});
`;

const GENERAL = `
import { spawn } from "node:child_process";
const child = spawn("/bin/sh", ["-c", "printf hello"], { stdio: ["ignore", "pipe", "pipe"] });
child.stdout?.pause();
child.stdout?.on("close", () => {
  console.log("closed");
});
`;

let directory: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "scriptc-child-stream-flow-"));
  writeFileSync(join(directory, "flow.ts"), FLOW);
  writeFileSync(join(directory, "general.ts"), GENERAL);
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** Lower one program, collecting the names of the whole-program lowering
 * passes it took (SCRIPTC_TIMING). */
function lower(file: string): { result: LowerResult; passes: string[] } {
  const load = loadProgram(join(directory, file));
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
    });
    const passes = lines
      .filter((line) => line.startsWith("scriptc lowering "))
      .map(
        (line) => (JSON.parse(line.slice("scriptc lowering ".length)) as { phase: string }).phase,
      )
      .filter((phase) => phase === "reachable-emit" || phase.endsWith("-relower"));
    return { result, passes };
  } finally {
    process.stderr.write = stderr;
    if (previous === undefined) delete process.env["SCRIPTC_TIMING"];
    else process.env["SCRIPTC_TIMING"] = previous;
    load.dispose();
  }
}

test("pausing and resuming a child's output lowers in one pass, on the handle", () => {
  const { result, passes } = lower("flow.ts");
  expect(result.diagnostics).toEqual([]);
  expect(result.runtimeFences).toEqual([]);
  expect(passes).toEqual(["reachable-emit"]);
  expect(result.module).not.toBeNull();
  const features = moduleRuntimeFeatures(result.module!);
  // The handle's flowing state is a build of the child unit of its own; the
  // runtime stream classes stay out of the program.
  expect(features).toMatchObject({ childProcess: true, childStreamFlow: true, stream: false });
});

test("a member the handle lacks still selects the general stream representation", () => {
  const { result, passes } = lower("general.ts");
  expect(result.diagnostics).toEqual([]);
  expect(passes).toEqual(["reachable-emit", "general-streams-relower"]);
  // There pause() is the runtime Readable's, so the child unit keeps its
  // default build.
  expect(moduleRuntimeFeatures(result.module!)).toMatchObject({
    childStreamFlow: false,
    stream: true,
  });
});
