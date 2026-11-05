#!/usr/bin/env node
// Prints the CI cache identity of one platform's libnode build as
// GitHub Actions outputs: `key` (Node release, configure flags, platform,
// toolchain), `path` (the staged build directory under the cache root,
// relative to it) and `bridge` (the bridge source hash, which is not part
// of the key: a bridge change reuses the cached libnode).
//
//   node packages/libnode-common/scripts/cache-key.mjs --platform <p> [--toolchain <t>]
import { parseArgs } from "node:util";
import { bridgeHash, libnodeCacheKey, readPin } from "./pin.mjs";

const { values } = parseArgs({
  options: { platform: { type: "string" }, toolchain: { type: "string" } },
});
if (!values.platform) {
  console.error("usage: cache-key.mjs --platform <platform> [--toolchain <name>]");
  process.exit(2);
}
const pin = readPin();
const key = libnodeCacheKey(values.platform, values.toolchain);
process.stdout.write(
  [
    `key=libnode-${values.platform}-${pin.nodeVersion}-${key}`,
    `path=${values.platform}-${pin.nodeVersion}-${key.slice(0, 16)}`,
    `bridge=${bridgeHash()}`,
    `node=${pin.nodeVersion}`,
    "",
  ].join("\n"),
);
