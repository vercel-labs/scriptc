import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";
import { checkerReadsLibrariesFromDisk, setCheckerFeatureStore } from "./checker-features.js";

const dir = mkdtempSync(join(tmpdir(), "scriptc-checker-features-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => setCheckerFeatureStore(null));

/** A stand-in checker that records its arguments and exits with `status`. */
function checker(name: string, status: number): { path: string; log: string } {
  const path = join(dir, name);
  const log = path + ".log";
  writeFileSync(path, `#!/bin/sh\necho "$@" >> '${log}'\nexit ${status}\n`);
  chmodSync(path, 0o755);
  return { path, log };
}

test.skipIf(process.platform === "win32")(
  "the checker is asked once whether it reads its library files from the disk, and the answer is stored",
  async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const entries = new Map<string, string>();
    setCheckerFeatureStore({
      read: (key) => entries.get(key) ?? null,
      write: (key, text) => void entries.set(key, text),
    });
    const current = checker("current", 0);
    const released = checker("released", 2);
    expect(checkerReadsLibrariesFromDisk(current.path, {})).toBe(true);
    expect(checkerReadsLibrariesFromDisk(released.path, {})).toBe(false);
    expect(readFileSync(current.log, "utf8")).toBe("--api --default-libraries-from-disk\n");
    expect([...entries.values()].sort()).toEqual(["0", "1"]);
    // Later asks use the answers: the checkers do not run again.
    expect(checkerReadsLibrariesFromDisk(current.path, {})).toBe(true);
    expect(checkerReadsLibrariesFromDisk(released.path, {})).toBe(false);
    expect(readFileSync(current.log, "utf8").split("\n").length).toBe(2);
    expect(readFileSync(released.log, "utf8").split("\n").length).toBe(2);
    // tsgo is never asked.
    const tsgo = checker("tsgo", 0);
    expect(checkerReadsLibrariesFromDisk(tsgo.path, { SCRIPTC_CHECKER: "tsgo" })).toBe(false);
    expect(existsSync(tsgo.log)).toBe(false);
  },
);
