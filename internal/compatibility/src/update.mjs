#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2).filter((arg) => arg === "--check" || arg === "--local");

for (const script of ["generate.mjs"]) {
  const result = spawnSync(process.execPath, [`src/${script}`, ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
