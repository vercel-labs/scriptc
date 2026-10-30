// The libnode pin and the platform table shared by the libnode pack build,
// its CI cache keys, the pack verifier, and the smoke test.
//
// A libnode pack (`@scriptc/libnode-<platform>`) holds a stripped Node.js
// shared library built from the pinned release, the C++ bridge compiled
// against that release's headers, Node's license, and manifest.json. The
// scriptc runtime dlopens the bridge on its first call into Node and talks
// to it only through the C ABI in packages/runtime/src/scr_node_bridge.h.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const commonRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const repoRoot = dirname(dirname(commonRoot));
export const bridgeSource = join(commonRoot, "bridge", "scr_node_bridge.cc");
export const bridgeHeader = join(repoRoot, "packages", "runtime", "src", "scr_node_bridge.h");

export { LIBNODE_PACK_SCHEMA, bridgeAbi } from "../build-pack.mjs";

/** Bump to invalidate every cached libnode build (a change to how the
 * library is built or staged that the pin does not capture). */
const BUILD_RECIPE = 1;

/**
 * @typedef {{
 *   nodeVersion: string,
 *   tarballSha256: string,
 *   moduleVersion: number,
 *   configureFlags: string[],
 *   icu: "full" | "small",
 * }} LibnodePin
 */

/** @returns {LibnodePin} */
export function readPin() {
  return JSON.parse(readFileSync(join(commonRoot, "libnode.json"), "utf8"));
}

/** Pack platforms: the npm package suffix, the Node `os`/`arch`, and the
 * file names inside the pack. The darwin packs build only on macOS hosts. */
export const LIBNODE_PLATFORMS = {
  "linux-x64-gnu": { os: "linux", arch: "x64", target: "linux-x64-gnu" },
  "linux-arm64-gnu": { os: "linux", arch: "arm64", target: "linux-arm64-gnu" },
  "darwin-arm64": { os: "darwin", arch: "arm64", target: "macos-arm64" },
  "darwin-x64": { os: "darwin", arch: "x64", target: "macos-x64" },
};

/** @param {string} platform */
export function platformInfo(platform) {
  const info = LIBNODE_PLATFORMS[/** @type {keyof typeof LIBNODE_PLATFORMS} */ (platform)];
  if (info === undefined) throw new Error(`unknown libnode pack platform ${platform}`);
  return info;
}

/** The library names inside a pack for one platform and module version. */
export function packFileNames(platform, moduleVersion) {
  const { os } = platformInfo(platform);
  return os === "darwin"
    ? { libnode: `libnode.${moduleVersion}.dylib`, bridge: "libscr_node_bridge.dylib" }
    : { libnode: `libnode.so.${moduleVersion}`, bridge: "libscr_node_bridge.so" };
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** The cache key of the libnode build itself: the Node release, how it is
 * configured, the platform and toolchain. The bridge is not part of it; a
 * bridge change rebuilds only the bridge against the cached headers. */
export function libnodeCacheKey(platform, toolchain = process.env.SCRIPTC_LIBNODE_TOOLCHAIN) {
  const pin = readPin();
  platformInfo(platform);
  return sha256(
    JSON.stringify({
      recipe: BUILD_RECIPE,
      nodeVersion: pin.nodeVersion,
      tarballSha256: pin.tarballSha256,
      configureFlags: pin.configureFlags,
      icu: pin.icu,
      platform,
      toolchain: toolchain ?? "default",
    }),
  );
}

/** The hash of everything the bridge is compiled from. */
export function bridgeHash() {
  return sha256(readFileSync(bridgeSource, "utf8") + "\0" + readFileSync(bridgeHeader, "utf8"));
}
