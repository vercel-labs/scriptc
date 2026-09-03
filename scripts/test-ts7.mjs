#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(
  pnpm,
  ["exec", "vitest", "run", "packages/compiler/test/ts7"],
  {
    stdio: "inherit",
    env: { ...process.env, SCRIPTC_TS7_ALL: "1" },
  },
);

if (result.error !== undefined) {
  console.error(result.error.message);
  process.exitCode = 1;
} else if (result.signal !== null) {
  console.error(`TypeScript 7 parity sweep terminated by ${result.signal}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
