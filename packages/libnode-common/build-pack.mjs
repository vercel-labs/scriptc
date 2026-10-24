#!/usr/bin/env node
/* Assembles a libnode pack: the directory a scriptc program with Node
 * islands loads Node from (scope-B design §2.16.3), from a Node `--shared`
 * build and the headers of the same release:
 *
 *   node packages/libnode-common/build-pack.mjs \
 *     --libnode <path to libnode.so.<ABI> or libnode.<ABI>.dylib> \
 *     --headers <include/node directory of the same Node release> \
 *     --out <pack directory> [--license <Node's LICENSE>] [--cxx <compiler>]
 *
 * The pack holds libnode, the bridge (bridge/scr_node_bridge.cc) compiled
 * against those headers and linked to libnode through $ORIGIN /
 * @loader_path (so the directory can move), Node's license and
 * manifest.json, which the build of a program with Node islands reads
 * (packages/compiler/src/node-islands/libnode.ts). Programs find a pack
 * through --libnode, SCRIPTC_LIBNODE, or the installed
 * @scriptc/libnode-<platform> package.
 *
 * The @scriptc/libnode-<platform> packs call buildPack() from
 * scripts/build.mjs after building libnode from the pinned release; run by
 * hand, this is the bridge-only rebuild path (seconds) and the way a
 * self-builder pairs the bridge with a compatible Node build of their own. */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = fileURLToPath(new URL(".", import.meta.url));
const runtimeSrc = join(here, "../runtime/src");

/** The manifest schema; the compiler's pack reader accepts exactly this. */
export const LIBNODE_PACK_SCHEMA = "scriptc.libnode-pack.v1";

/** The bridge ABI the runtime expects (scr_node_bridge.h). */
export function bridgeAbi() {
  const header = readFileSync(join(runtimeSrc, "scr_node_bridge.h"), "utf8");
  return Number(/#define SCR_NODE_BRIDGE_ABI (\d+)u/.exec(header)[1]);
}

/** The Node version and NODE_MODULE_VERSION of a header directory. */
export function nodeVersionOf(headers) {
  const text = readFileSync(join(headers, "node_version.h"), "utf8");
  const define = (name) => Number(new RegExp(`#define ${name} (\\d+)`).exec(text)[1]);
  return {
    nodeVersion: `${define("NODE_MAJOR_VERSION")}.${define("NODE_MINOR_VERSION")}.${define("NODE_PATCH_VERSION")}`,
    moduleVersion: define("NODE_MODULE_VERSION"),
  };
}

function fileEntry(path) {
  return {
    size: statSync(path).size,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

/** The bridge library name on a platform. */
export function bridgeName(os = process.platform) {
  return os === "darwin" ? "libscr_node_bridge.dylib" : "libscr_node_bridge.so";
}

/** Compiles the bridge against `headers` (an include/node directory) and
 * links it to `libnode`, which must already sit in the bridge's directory. */
export function buildBridge({ headers, libnode, out, cxx }) {
  const darwin = process.platform === "darwin";
  const compiler = cxx ?? process.env.CXX ?? (darwin ? "clang++" : "g++");
  const link = darwin
    ? [
        "-dynamiclib",
        libnode,
        "-Wl,-rpath,@loader_path",
        `-Wl,-install_name,@rpath/${basename(out)}`,
      ]
    : [
        "-shared",
        `-L${dirname(libnode)}`,
        `-l:${basename(libnode)}`,
        "-Wl,-rpath,$ORIGIN",
        "-Wl,-z,defs",
        "-Wl,--as-needed",
        "-ldl",
        "-pthread",
      ];
  execFileSync(
    compiler,
    [
      "-std=c++20",
      "-O2",
      "-fPIC",
      "-fvisibility=hidden",
      "-fno-rtti",
      "-I",
      runtimeSrc,
      "-I",
      headers,
      join(here, "bridge/scr_node_bridge.cc"),
      ...link,
      "-o",
      out,
    ],
    { stdio: "inherit" },
  );
  if (darwin) {
    execFileSync("strip", ["-x", out], { stdio: "inherit" });
    // Stripping invalidated the linker's ad-hoc signature, which arm64
    // macOS requires to map the library.
    execFileSync("codesign", ["--force", "--sign", "-", out], { stdio: "inherit" });
  } else {
    execFileSync("strip", ["--strip-unneeded", out], { stdio: "inherit" });
  }
}

/**
 * Assembles the pack in `out` and returns its manifest. `extra` adds fields
 * to manifest.json (the published packs record their package, target and
 * build inputs); schema, nodeVersion, moduleVersion, bridgeAbi, platform,
 * arch, libnode, bridge and files are always present.
 *
 * @param {{ libnode: string, headers: string, out: string, license?: string,
 *   cxx?: string, extra?: Record<string, unknown> }} options
 */
export function buildPack(options) {
  const out = resolve(options.out);
  const headers = resolve(options.headers);
  mkdirSync(out, { recursive: true });
  const libnodeName = basename(options.libnode);
  const libnode = join(out, libnodeName);
  if (resolve(options.libnode) !== libnode) copyFileSync(options.libnode, libnode);
  const bridge = join(out, bridgeName());
  buildBridge({ headers, libnode, out: bridge, cxx: options.cxx });
  if (options.license) copyFileSync(options.license, join(out, "LICENSE"));
  const { nodeVersion, moduleVersion } = nodeVersionOf(headers);
  const manifest = {
    schema: LIBNODE_PACK_SCHEMA,
    nodeVersion,
    moduleVersion,
    bridgeAbi: bridgeAbi(),
    platform: process.platform,
    arch: process.arch,
    libnode: libnodeName,
    bridge: bridgeName(),
    ...options.extra,
    files: {
      [libnodeName]: fileEntry(libnode),
      [bridgeName()]: fileEntry(bridge),
    },
  };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      libnode: { type: "string" },
      headers: { type: "string" },
      out: { type: "string" },
      license: { type: "string" },
      cxx: { type: "string" },
    },
  });
  if (!values.libnode || !values.headers || !values.out) {
    console.error("usage: build-pack.mjs --libnode <lib> --headers <include/node> --out <dir>");
    process.exit(2);
  }
  const manifest = buildPack({
    libnode: values.libnode,
    headers: values.headers,
    out: values.out,
    license: values.license,
    cxx: values.cxx,
  });
  console.log(`libnode pack for Node ${manifest.nodeVersion} in ${resolve(values.out)}`);
}
