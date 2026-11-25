/* The names the compiler gives its scratch files beside an output are the
 * ones the frontend's input replay sets aside in a listing
 * (COMPILER_SCRATCH_PREFIX): a build's own temporary files must not make
 * its cache entry stale. */
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import { privateSiblingPath } from "../src/backend/build-cache.js";
import { COMPILER_SCRATCH_PREFIX } from "../src/frontend/input-tracker.js";

test("private sibling paths carry the scratch prefix the input replay ignores", () => {
  for (const label of ["frontend", "llvm", "ir", "install", "native-input", "native-exe"]) {
    const path = privateSiblingPath(join("/project", "out", "program"), label);
    expect(basename(path).startsWith(COMPILER_SCRATCH_PREFIX)).toBe(true);
    expect(join(path, "..")).toBe(join("/project", "out"));
  }
});
