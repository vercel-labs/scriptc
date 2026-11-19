import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ensureExecutable } from "./executable-mode.js";
import { spawnTs7Wire } from "./frontend/ts7/rpc-process.js";

const scratchDirs: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-mode-"));
  scratchDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of scratchDirs.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const posix = process.platform === "win32" ? test.skip : test;

posix("repairs a payload installed without execute bits", () => {
  const executable = join(scratch(), "tsc-ts");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o644);

  ensureExecutable(executable);

  expect(statSync(executable).mode & 0o777).toBe(0o755);
  // The repaired payload really runs.
  expect(execFileSync(executable, [], { encoding: "utf8" })).toBe("");
});

posix("leaves an executable payload alone", () => {
  const executable = join(scratch(), "tsc-ts");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o750);

  ensureExecutable(executable);

  expect(statSync(executable).mode & 0o777).toBe(0o750);
});

posix("reports a read-only payload without execute bits", () => {
  const executable = join(scratch(), "tsc-ts");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o444);

  expect(() => ensureExecutable(executable)).toThrow(
    `mode 444) and could not be repaired; fix it with: chmod +x "${executable}"`,
  );
});

test("names a missing payload", () => {
  expect(() => ensureExecutable(join(scratch(), "absent"))).toThrow(
    /is missing; reinstall scriptc/,
  );
});

posix("spawns a checker whose installed modes were stripped", () => {
  const executable = join(scratch(), "tsc-ts");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o644);

  // The fake checker is not a TypeScript server, so the wire may fail once
  // it exits; what matters is that the spawn was reached and the mode
  // repaired before it.
  let wire: ReturnType<typeof spawnTs7Wire> | null = null;
  try {
    wire = spawnTs7Wire(executable, ["--api"]);
  } catch {
    /* the fake server exits as it starts */
  }
  expect(statSync(executable).mode & 0o100).toBe(0o100);
  wire?.close();
});
