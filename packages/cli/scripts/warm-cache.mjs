#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostSupportsRuntimePack } from "./runtime-pack-host.mjs";

// Workspace installs should stay cheap and deterministic: repository test
// images already manage cache warming explicitly. Published npm packages do
// not contain src/, so only installed consumers take this best-effort path.
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
if (
  !existsSync(join(packageRoot, "src")) &&
  process.env["SCRIPTC_NO_CACHE"] !== "1" &&
  // A supported platform install already carries immutable release/dev
  // runtime artifacts. Unsupported hosts retain the source-toolchain path.
  !hostSupportsRuntimePack()
) {
  try {
    const { warmNativeCaches } = await import("@scriptc/compiler");
    await warmNativeCaches();
  } catch (error) {
    // Installation must never depend on a native toolchain. A machine without
    // clang/ar (or with lifecycle scripts disabled) retains ordinary lazy
    // first-build behavior; explicit `scriptc cache warm` reports errors.
    if (process.env["SCRIPTC_CACHE_WARM_DEBUG"] === "1") {
      process.stderr.write(`scriptc: cache warm skipped: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
