#!/usr/bin/env node
// Builds one libnode pack into its package directory:
//
//   1. libnode: the pinned Node.js release (libnode.json) from its official
//      source tarball, SHA-256 verified, configured `--shared` with full ICU,
//      only the `libnode` target built, stripped, staged with its headers
//      and LICENSE in a cache directory keyed by libnodeCacheKey(). A cache
//      hit skips the Node build entirely (about 26 minutes on 8 cores).
//   2. the bridge, compiled against those headers (seconds, every run);
//   3. the pack: libnode, the bridge, Node's LICENSE and manifest.json in
//      packages/libnode-<platform>/, plus `--compress` copies (.zst) of both
//      libraries in <cache>/compressed/ for size reports and embedding.
//
// This never runs in `pnpm -r build` or the test suites: each platform
// package runs it through its explicit `build:native` script, and the
// libnode-packs workflow runs that on matching hosts.
//
// Environment:
//   SCRIPTC_LIBNODE_CACHE      cache root (default node_modules/.cache/scriptc-libnode)
//   SCRIPTC_LIBNODE_SOURCE     an extracted source tree of the pinned release to
//                              build in (seeds the cache from an earlier build tree)
//   SCRIPTC_LIBNODE_TOOLCHAIN  a name for the toolchain, part of the cache key
//                              (CI: "manylinux_2_28-gcc14", "macos-15-clang")
//   SCRIPTC_LIBNODE_JOBS       ninja parallelism (default: available cores)
//   CC, CXX                    the compilers for Node and the bridge
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildPack } from "../build-pack.mjs";
import {
  bridgeAbi,
  bridgeHash,
  libnodeCacheKey,
  packFileNames,
  platformInfo,
  readPin,
  repoRoot,
} from "./pin.mjs";

function log(message) {
  process.stdout.write(`libnode: ${message}\n`);
}

function run(command, args, options = {}) {
  log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", ...options });
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Downloads and verifies the pinned source tarball, then extracts it. */
async function fetchSource(cacheRoot, pin) {
  const name = `node-v${pin.nodeVersion}`;
  const tree = join(cacheRoot, "src", name);
  if (existsSync(join(tree, "configure.py"))) return tree;
  const tarball = join(cacheRoot, "src", `${name}.tar.xz`);
  mkdirSync(join(cacheRoot, "src"), { recursive: true });
  if (!existsSync(tarball) || (await sha256File(tarball)) !== pin.tarballSha256) {
    const url = `https://nodejs.org/dist/v${pin.nodeVersion}/${name}.tar.xz`;
    run("curl", ["-fsSL", "--retry", "3", "-o", `${tarball}.part`, url]);
    renameSync(`${tarball}.part`, tarball);
  }
  const actual = await sha256File(tarball);
  if (actual !== pin.tarballSha256) {
    rmSync(tarball, { force: true });
    throw new Error(`${name}.tar.xz has SHA-256 ${actual}, expected ${pin.tarballSha256}`);
  }
  rmSync(tree, { recursive: true, force: true });
  run("tar", ["-xJf", tarball, "-C", join(cacheRoot, "src")]);
  return tree;
}

/** The version a source tree's node_version.h declares. */
function sourceVersion(tree) {
  const text = readFileSync(join(tree, "src", "node_version.h"), "utf8");
  const define = (name) => new RegExp(`#define ${name} (\\d+)`).exec(text)?.[1];
  return `${define("NODE_MAJOR_VERSION")}.${define("NODE_MINOR_VERSION")}.${define("NODE_PATCH_VERSION")}`;
}

function moduleVersionOf(headers) {
  const text = readFileSync(join(headers, "include", "node", "node_version.h"), "utf8");
  return Number(/#define NODE_MODULE_VERSION (\d+)/.exec(text)?.[1]);
}

/** The highest GLIBC_x.y symbol version a Linux library needs. */
function minimumGlibc(library) {
  const dynamic = execFileSync("objdump", ["-T", library], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const versions = [...new Set(dynamic.match(/GLIBC_\d+(\.\d+)+/g) ?? [])].map((v) =>
    v.slice("GLIBC_".length),
  );
  versions.sort((a, b) => {
    const x = a.split(".").map(Number);
    const y = b.split(".").map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    }
    return 0;
  });
  return versions.at(-1) ?? null;
}

/** Configures and builds libnode in `tree`, then stages it into `stage`. */
function buildLibnode(tree, stage, platform, pin) {
  const { os } = platformInfo(platform);
  if (sourceVersion(tree) !== pin.nodeVersion) {
    throw new Error(`${tree} is Node ${sourceVersion(tree)}, the pin is ${pin.nodeVersion}`);
  }
  const python = process.env.PYTHON ?? "python3";
  // An earlier tree configured with exactly these flags is reused as is, so
  // a seeded build tree is a ninja no-op instead of a reconfigure.
  const status = join(tree, "config.status");
  const configured =
    existsSync(status) &&
    existsSync(join(tree, "out", "Release", "build.ninja")) &&
    readFileSync(status, "utf8")
      .trimEnd()
      .endsWith(`configure ${pin.configureFlags.join(" ")}`);
  const started = Date.now();
  if (!configured) run("./configure", pin.configureFlags, { cwd: tree });
  const gypi = readFileSync(join(tree, "config.gypi"), "utf8");
  for (const [setting, expected] of [
    ["node_shared", "true"],
    ["node_use_node_snapshot", "true"],
    ["icu_small", pin.icu === "small" ? "true" : "false"],
  ]) {
    if (!gypi.includes(`"${setting}": "${expected}"`)) {
      throw new Error(`config.gypi does not have ${setting}: ${expected}`);
    }
  }
  const jobs = process.env.SCRIPTC_LIBNODE_JOBS ?? String(availableParallelism());
  run("ninja", ["-C", join(tree, "out", "Release"), "-j", jobs, "libnode"]);
  const buildSeconds = Math.round((Date.now() - started) / 1000);

  const names = packFileNames(platform, pin.moduleVersion);
  const built = [
    join(tree, "out", "Release", "lib", names.libnode),
    join(tree, "out", "Release", names.libnode),
  ].find((path) => existsSync(path));
  if (built === undefined) throw new Error(`the Node build did not produce ${names.libnode}`);
  const partial = `${stage}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(join(partial, "lib"), { recursive: true });
  const library = join(partial, "lib", names.libnode);
  if (os === "darwin") {
    copyFileSync(built, library);
    run("install_name_tool", ["-id", `@rpath/${names.libnode}`, library]);
    // -x keeps the global symbols addons and the bridge bind to.
    run("strip", ["-x", library]);
    // Editing the library invalidated the linker's ad-hoc signature, which
    // arm64 macOS requires to map it.
    run("codesign", ["--force", "--sign", "-", library]);
  } else {
    run("strip", ["--strip-unneeded", "-o", library, built]);
  }
  run(
    python,
    [
      join(tree, "tools", "install.py"),
      "install",
      "--headers-only",
      "--silent",
      "--root-dir",
      tree,
      "--dest-dir",
      join(partial, "headers"),
      "--prefix",
      "/",
    ],
    { cwd: tree },
  );
  const moduleVersion = moduleVersionOf(join(partial, "headers"));
  if (moduleVersion !== pin.moduleVersion) {
    throw new Error(
      `Node ${pin.nodeVersion} has NODE_MODULE_VERSION ${moduleVersion}, the pin says ${pin.moduleVersion}`,
    );
  }
  copyFileSync(join(tree, "LICENSE"), join(partial, "LICENSE"));
  writeFileSync(
    join(partial, "build.json"),
    `${JSON.stringify(
      {
        nodeVersion: pin.nodeVersion,
        moduleVersion,
        configureFlags: pin.configureFlags,
        icu: pin.icu,
        toolchain: process.env.SCRIPTC_LIBNODE_TOOLCHAIN ?? "default",
        buildSeconds,
        builtBytes: statSync(built).size,
        minimumGlibc: os === "linux" ? minimumGlibc(library) : null,
      },
      null,
      2,
    )}\n`,
  );
  rmSync(stage, { recursive: true, force: true });
  renameSync(partial, stage);
}

/** zstd copies of the pack's libraries, for size reports and embedding. */
function compress(pack, names, out) {
  mkdirSync(out, { recursive: true });
  const sizes = {};
  for (const name of [names.libnode, names.bridge]) {
    const target = join(out, `${name}.zst`);
    const started = Date.now();
    run("zstd", ["-19", "-T0", "-q", "-f", join(pack, name), "-o", target]);
    sizes[name] = { zstdBytes: statSync(target).size, seconds: (Date.now() - started) / 1000 };
  }
  return sizes;
}

/**
 * @param {{ platform: string, packageRoot: string, compress?: boolean, skipLibnode?: boolean }} options
 */
export async function buildLibnodePack(options) {
  const { platform, packageRoot } = options;
  const { os, arch } = platformInfo(platform);
  const pin = readPin();
  const cacheRoot = resolve(
    process.env.SCRIPTC_LIBNODE_CACHE ??
      join(repoRoot, "node_modules", ".cache", "scriptc-libnode"),
  );
  const key = libnodeCacheKey(platform);
  const stage = join(cacheRoot, `${platform}-${pin.nodeVersion}-${key.slice(0, 16)}`);
  const names = packFileNames(platform, pin.moduleVersion);
  if (existsSync(join(stage, "build.json"))) {
    log(`cached libnode ${pin.nodeVersion} for ${platform} in ${stage}`);
  } else {
    if (options.skipLibnode) throw new Error(`no cached libnode build in ${stage}`);
    const tree = process.env.SCRIPTC_LIBNODE_SOURCE
      ? resolve(process.env.SCRIPTC_LIBNODE_SOURCE)
      : await fetchSource(cacheRoot, pin);
    buildLibnode(tree, stage, platform, pin);
  }
  const build = JSON.parse(readFileSync(join(stage, "build.json"), "utf8"));

  for (const name of [names.libnode, names.bridge, "LICENSE", "manifest.json"]) {
    rmSync(join(packageRoot, name), { force: true });
  }
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const bridgeStarted = Date.now();
  const manifest = buildPack({
    libnode: join(stage, "lib", names.libnode),
    headers: join(stage, "headers", "include", "node"),
    out: packageRoot,
    license: join(stage, "LICENSE"),
    extra: {
      package: packageJson.name,
      version: packageJson.version,
      target: platform,
      license: "LICENSE",
      build: {
        libnodeKey: key,
        bridgeHash: bridgeHash(),
        configureFlags: build.configureFlags,
        icu: build.icu,
        toolchain: build.toolchain,
        minimumGlibc: build.minimumGlibc,
      },
    },
  });
  const bridgeSeconds = (Date.now() - bridgeStarted) / 1000;
  if (
    manifest.nodeVersion !== pin.nodeVersion ||
    manifest.moduleVersion !== pin.moduleVersion ||
    manifest.bridgeAbi !== bridgeAbi() ||
    manifest.platform !== os ||
    manifest.arch !== arch ||
    manifest.libnode !== names.libnode ||
    manifest.bridge !== names.bridge
  ) {
    throw new Error(`the assembled pack does not match ${platform}: ${JSON.stringify(manifest)}`);
  }
  const report = {
    platform,
    nodeVersion: pin.nodeVersion,
    libnodeBuildSeconds: build.buildSeconds,
    libnodeBuiltBytes: build.builtBytes,
    libnodeStrippedBytes: manifest.files[names.libnode].size,
    bridgeBytes: manifest.files[names.bridge].size,
    bridgeSeconds,
    minimumGlibc: manifest.build.minimumGlibc,
  };
  if (options.compress) {
    report.compressed = compress(packageRoot, names, join(cacheRoot, "compressed", platform));
  }
  log(`pack ${packageJson.name} for Node ${pin.nodeVersion}: ${JSON.stringify(report)}`);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      platform: { type: "string" },
      "package-root": { type: "string" },
      compress: { type: "boolean", default: false },
      "skip-libnode": { type: "boolean", default: false },
      report: { type: "string" },
    },
  });
  if (!values.platform) {
    console.error("usage: build.mjs --platform <platform> [--package-root <dir>] [--compress]");
    process.exit(2);
  }
  const packageRoot = resolve(
    values["package-root"] ?? join(repoRoot, "packages", `libnode-${values.platform}`),
  );
  const report = await buildLibnodePack({
    platform: values.platform,
    packageRoot,
    compress: values.compress,
    skipLibnode: values["skip-libnode"],
  });
  if (values.report) writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`);
}
