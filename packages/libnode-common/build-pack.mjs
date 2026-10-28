#!/usr/bin/env node
/* Assembles a libnode pack: the directory a scriptc program with Node
 * islands loads Node from (scope-B design §2.16.3). Until the pack CI
 * matrix (NI-13) publishes @scriptc/libnode-<platform> packages, packs are
 * assembled by hand from a Node `--shared` build and the matching headers:
 *
 *   node packages/libnode-common/build-pack.mjs \
 *     --libnode <path to libnode.so.<ABI> or libnode.<ABI>.dylib> \
 *     --headers <include/node directory of the same Node release> \
 *     --out <pack directory> [--license <Node's LICENSE>] [--cxx <compiler>]
 *
 * The pack holds libnode, the bridge (bridge/scr_node_bridge.cc) compiled
 * against those headers, Node's license and manifest.json, which the build
 * of a program with Node islands reads (packages/compiler/src/node-islands/
 * libnode.ts). Programs find a pack through SCRIPTC_LIBNODE or --libnode. */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = fileURLToPath(new URL(".", import.meta.url));
const runtimeSrc = join(here, "../runtime/src");

/** The bridge ABI the runtime expects (scr_node_bridge.h). */
function bridgeAbi() {
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      libnode: { type: "string" },
      headers: { type: "string" },
      out: { type: "string" },
      license: { type: "string" },
      cxx: { type: "string", default: process.platform === "darwin" ? "clang++" : "g++" },
    },
  });
  if (!values.libnode || !values.headers || !values.out) {
    console.error("usage: build-pack.mjs --libnode <lib> --headers <include/node> --out <dir>");
    process.exit(2);
  }
  const out = resolve(values.out);
  const headers = resolve(values.headers);
  mkdirSync(out, { recursive: true });
  const libnodeName = basename(values.libnode);
  copyFileSync(values.libnode, join(out, libnodeName));
  const bridgeName =
    process.platform === "darwin" ? "libscr_node_bridge.dylib" : "libscr_node_bridge.so";
  const link =
    process.platform === "darwin"
      ? ["-dynamiclib", join(out, libnodeName), "-Wl,-rpath,@loader_path"]
      : ["-shared", `-L${out}`, `-l:${libnodeName}`, "-Wl,-rpath,$ORIGIN"];
  execFileSync(
    values.cxx,
    [
      "-std=c++20",
      "-O2",
      "-fPIC",
      "-fvisibility=hidden",
      "-I",
      runtimeSrc,
      "-I",
      headers,
      join(here, "bridge/scr_node_bridge.cc"),
      ...link,
      "-o",
      join(out, bridgeName),
    ],
    { stdio: "inherit" },
  );
  if (values.license) copyFileSync(values.license, join(out, "LICENSE"));
  const { nodeVersion, moduleVersion } = nodeVersionOf(headers);
  const manifest = {
    schema: "scriptc.libnode-pack.v1",
    nodeVersion,
    moduleVersion,
    bridgeAbi: bridgeAbi(),
    platform: process.platform,
    arch: process.arch,
    files: {
      [libnodeName]: fileEntry(join(out, libnodeName)),
      [bridgeName]: fileEntry(join(out, bridgeName)),
    },
  };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`libnode pack for Node ${nodeVersion} in ${out}`);
}
