import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

/** The lines the execution of `sources` prints, one per line. */
async function slotAnswers(sources: string[]): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-dyn-slot-"));
  try {
    const bin = join(dir, "slot");
    await exec("clang", [
      "-std=c11",
      "-O1",
      "-Wall",
      "-Wextra",
      ...sources.map((source) => join(import.meta.dirname, source)),
      "-o",
      bin,
    ]);
    const { stdout } = await exec(bin, []);
    return stdout.trim().split(/\r?\n/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The slots carry the object model's cross-unit edges (scr_dyn.h): the reader
// links no providing unit when the program reads an intrinsic without naming
// a wrapper, and must then take its fallback rather than fault.
test("a slot no unit provides reads NULL and the reader takes its fallback", async () => {
  expect(await slotAnswers(["scr_dyn.test.c"])).toEqual(["fallback"]);
});

test("the providing unit's strong definition overrides the fallback", async () => {
  expect(await slotAnswers(["scr_dyn.test.c", "scr_dyn_slot_provider.test.c"])).toEqual([
    "provided String.prototype",
  ]);
});
