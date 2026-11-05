#!/usr/bin/env node
// Builds @scriptc/libnode-linux-arm64-gnu: libnode for the pinned Node.js release
// and the bridge (packages/libnode-common/scripts/build.mjs). The Node
// build takes about half an hour on 8 cores and is cached by Node version,
// configure flags and toolchain; only the libnode-packs workflow and an
// explicit `pnpm --filter @scriptc/libnode-linux-arm64-gnu build:native` run it.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLibnodePack } from "../../libnode-common/scripts/build.mjs";

if (process.platform !== "linux" || process.arch !== "arm64") {
  process.stdout.write("@scriptc/libnode-linux-arm64-gnu: skipped on this host\n");
  process.exit(0);
}
await buildLibnodePack({
  platform: "linux-arm64-gnu",
  packageRoot: dirname(dirname(fileURLToPath(import.meta.url))),
  compress: process.argv.includes("--compress"),
  // Assemble from a restored libnode build only (CI test lanes); never
  // start a Node build.
  skipLibnode: process.argv.includes("--from-cache"),
});
