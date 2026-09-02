#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const check = process.argv.slice(2).includes("--check");
const args = check ? ["--check"] : [];

for (const script of ["generate-island-header.mjs", "generate.mjs"]) {
  const result = spawnSync(process.execPath, [`src/${script}`, ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
