#!/usr/bin/env node
/* Installs the Linux x64 toolchain the lanes build and link with, inside the
 * repository directory.
 *
 * Vercel CI gives every task a copy of the repository directory, so a tool a
 * task uses has to live inside that directory. The ci:setup:toolchain task
 * runs this script and declares .ci/toolchain as its output, so the toolchain
 * is restored from Vercel Remote Cache on later runs instead of downloaded
 * again; its inputs are the pins below and scripts/toolchain.sha256.
 *
 *   llvm-22.1.8   the pinned LLVM development distribution (LLVM_DIR, clang)
 *   zig           the pinned Zig (runtime pack C/C++ compiler and archiver)
 *   cmake         CMake, which the LLVM helper is configured with
 *   ninja         CMake's generator
 *   sysroot       static zlib and zstd libraries and headers: the static LLVM
 *                 helper links -lz and -lzstd, which the image does not ship
 *
 * Every archive is checked against its pinned SHA-256 before it is unpacked.
 * A checkout may carry files under .ci/ (git does not refuse a forced add of
 * an ignored path), so no file found there is trusted: every execution starts
 * from an empty tree and installs only from the pinned archives. Vercel Remote
 * Cache is the only way a run reuses a toolchain, and it restores one that an
 * execution built this way.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateRawSync, zstdDecompressSync } from "node:zlib";

const root = fileURLToPath(new URL("../../", import.meta.url));
const ci = join(root, ".ci");
const downloads = join(ci, "downloads");
const toolchain = join(ci, "toolchain");
// The installation revision, written into the tree and part of this file (one
// of the task's inputs): raising it invalidates cached toolchains built by an
// older revision.
const revision = 2;

// The LLVM pin is the repository's: scripts/toolchain.sha256 pins every LLVM
// archive the native builds use.
function llvmPin(filename) {
  const line = readFileSync(join(root, "scripts/toolchain.sha256"), "utf8")
    .split("\n")
    .find((candidate) => !candidate.startsWith("#") && candidate.trim().endsWith(` ${filename}`));
  if (line === undefined) throw new Error(`scripts/toolchain.sha256 pins no ${filename}`);
  return line.trim().split(/\s+/)[0];
}

const llvmArchive = "LLVM-22.1.8-Linux-X64.tar.xz";
const sources = [
  {
    name: llvmArchive,
    // LLVM publishes this archive on GitHub only; a partial response is retried rather than mirrored.
    urls: [`https://github.com/llvm/llvm-project/releases/download/llvmorg-22.1.8/${llvmArchive}`],
    sha256: llvmPin(llvmArchive),
  },
  {
    name: "zig-x86_64-linux-0.16.0.tar.xz",
    urls: [
      "https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz",
      "https://pkg.hexops.org/zig/zig-x86_64-linux-0.16.0.tar.xz",
      "https://zig.linus.dev/zig/zig-x86_64-linux-0.16.0.tar.xz",
    ],
    sha256: "70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00",
  },
  {
    name: "cmake-3.31.6-linux-x86_64.tar.gz",
    urls: [
      "https://cmake.org/files/v3.31/cmake-3.31.6-linux-x86_64.tar.gz",
      "https://github.com/Kitware/CMake/releases/download/v3.31.6/cmake-3.31.6-linux-x86_64.tar.gz",
    ],
    sha256: "5a1133ff103c71eb5120e2cc3de922733e7d8a26a98ae716397e8676adb367bf",
  },
  {
    // The wheel carries the statically addressable Ninja binary; the archive
    // is unpacked here so no Python or unzip program is needed.
    name: "ninja-1.13.2-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl",
    urls: [
      "https://files.pythonhosted.org/packages/6e/53/ebfed7b689c338dd8ebeec9c0730c8d56821292f14e2536e5f3ef1a05744/ninja-1.13.2-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl",
    ],
    sha256: "65a24341b5ac09fcadcc37082660be40a94174e51a937fabf6e2cae26225fa2c",
  },
  {
    // Ubuntu 24.04's development packages: their static archives and headers are copied into the sysroot. The
    // task image is the same release, but does not ship the -dev packages.
    name: "zlib1g-dev_1.3.dfsg-3.1ubuntu2.3_amd64.deb",
    urls: [
      "https://archive.ubuntu.com/ubuntu/pool/main/z/zlib/zlib1g-dev_1.3.dfsg-3.1ubuntu2.3_amd64.deb",
      "http://archive.ubuntu.com/ubuntu/pool/main/z/zlib/zlib1g-dev_1.3.dfsg-3.1ubuntu2.3_amd64.deb",
    ],
    sha256: "419902a649e1078f24596cdf31ced9c839519828790f59888056fcdcd58e8a28",
  },
  {
    name: "libzstd-dev_1.5.5+dfsg2-2build1_amd64.deb",
    urls: [
      "https://archive.ubuntu.com/ubuntu/pool/main/libz/libzstd/libzstd-dev_1.5.5+dfsg2-2build1_amd64.deb",
      "http://archive.ubuntu.com/ubuntu/pool/main/libz/libzstd/libzstd-dev_1.5.5+dfsg2-2build1_amd64.deb",
    ],
    sha256: "2692254b78b0beeb284cda9bd34883ba470881475bc7c0eefbef479404bcfd23",
  },
];

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function download({ name, urls, sha256: expected }) {
  const target = join(downloads, name);
  if (existsSync(target) && sha256(target) === expected) {
    console.log(`[toolchain] ${name}: already present (${statSync(target).size} bytes)`);
    return target;
  }
  rmSync(target, { force: true });
  const failures = [];
  for (const url of urls) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const started = Date.now();
      console.log(`[toolchain] ${name}: download ${attempt}/3 from ${url}`);
      const controller = new AbortController();
      let lastData = Date.now();
      let abortReason = null;
      const watchdog = setInterval(() => {
        const idle = Date.now() - lastData;
        if (idle > 60_000) abortReason = `no data for ${Math.round(idle / 1000)}s`;
        else if (Date.now() - started > 360_000) abortReason = "not finished within 360s";
        if (abortReason !== null) controller.abort(new Error(abortReason));
      }, 1_000);
      try {
        const response = await fetch(url, { redirect: "follow", signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        if (response.body === null) throw new Error("response has no body");
        const hash = createHash("sha256");
        let received = 0;
        let reported = 0;
        await pipeline(
          Readable.fromWeb(response.body),
          async function* (stream) {
            for await (const chunk of stream) {
              lastData = Date.now();
              hash.update(chunk);
              received += chunk.length;
              if (received - reported >= 100 * 1024 * 1024) {
                reported = received;
                console.log(
                  `[toolchain] ${name}: ${(received / 1048576).toFixed(0)} MB in ${((Date.now() - started) / 1000).toFixed(0)}s`,
                );
              }
              yield chunk;
            }
          },
          createWriteStream(target),
        );
        const actual = hash.digest("hex");
        if (actual !== expected) throw new Error(`sha256 ${actual}, expected ${expected}`);
        console.log(
          `[toolchain] ${name}: ${(received / 1048576).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)}s`,
        );
        return target;
      } catch (error) {
        failures.push(`${url} (attempt ${attempt}): ${abortReason ?? error.message}`);
        rmSync(target, { force: true });
        console.log(`[toolchain] ${name}: ${abortReason ?? error.message}; retrying`);
        await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
      } finally {
        clearInterval(watchdog);
      }
    }
  }
  throw new Error(`${name}: no source completed:\n${failures.join("\n")}`);
}

function untar(archive, directory) {
  mkdirSync(directory, { recursive: true });
  const compression = archive.endsWith(".xz") ? "-xJf" : archive.endsWith(".gz") ? "-xzf" : "-xf";
  execFileSync(
    "tar",
    [
      compression,
      archive,
      "-C",
      directory,
      "--no-same-owner",
      // A checkpoint names the extraction's progress, so a slow archive shows it is advancing rather than hung.
      "--checkpoint=50000",
      "--checkpoint-action=echo=extracting",
      "--totals",
    ],
    {
      stdio: "inherit",
      // Multi-threaded xz for an archive compressed in independent blocks.
      env: { ...process.env, XZ_OPT: "-T0", XZ_DEFAULTS: "-T0" },
    },
  );
}

/** Extracts the single Ninja executable from the wheel, without a zip tool. */
function extractNinja(wheel, directory) {
  const bytes = readFileSync(wheel);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && bytes.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("ninja wheel has no end of central directory record");
  const count = bytes.readUInt16LE(eocd + 10);
  let entry = bytes.readUInt32LE(eocd + 16);
  mkdirSync(directory, { recursive: true });
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(entry) !== 0x02014b50)
      throw new Error("ninja wheel has a bad directory entry");
    const method = bytes.readUInt16LE(entry + 10);
    const compressedSize = bytes.readUInt32LE(entry + 20);
    const nameLength = bytes.readUInt16LE(entry + 28);
    const extraLength = bytes.readUInt16LE(entry + 30);
    const commentLength = bytes.readUInt16LE(entry + 32);
    const localHeader = bytes.readUInt32LE(entry + 42);
    const name = bytes.toString("utf8", entry + 46, entry + 46 + nameLength);
    if (name.endsWith("/ninja")) {
      const localNameLength = bytes.readUInt16LE(localHeader + 26);
      const localExtraLength = bytes.readUInt16LE(localHeader + 28);
      const start = localHeader + 30 + localNameLength + localExtraLength;
      const compressed = bytes.subarray(start, start + compressedSize);
      const contents = method === 8 ? inflateRawSync(compressed) : compressed;
      const output = join(directory, "ninja");
      writeFileSync(output, contents);
      chmodSync(output, 0o755);
      return output;
    }
    entry += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("ninja wheel has no ninja executable");
}

/** Replaces `from` with `to`, where `from` is the directory an archive unpacked. */
function place(from, to) {
  rmSync(to, { recursive: true, force: true });
  renameSync(from, to);
}

/** Unpacks the data archive of a Debian package into `directory` and returns it. */
function extractDeb(deb, directory) {
  const bytes = readFileSync(deb);
  if (bytes.toString("ascii", 0, 8) !== "!<arch>\n")
    throw new Error(`${deb} is not a Debian package archive`);
  let offset = 8;
  while (offset + 60 <= bytes.length) {
    const name = bytes
      .toString("ascii", offset, offset + 16)
      .trim()
      .replace(/\/$/, "");
    const size = Number(bytes.toString("ascii", offset + 48, offset + 58).trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${deb} has a bad member size`);
    const start = offset + 60;
    if (name.startsWith("data.tar")) {
      const data = bytes.subarray(start, start + size);
      const tar = name.endsWith(".zst")
        ? zstdDecompressSync(data)
        : name.endsWith(".gz")
          ? gunzipSync(data)
          : data;
      mkdirSync(directory, { recursive: true });
      const path = join(directory, "data.tar");
      writeFileSync(path, tar);
      execFileSync("tar", ["-xf", path, "-C", directory], { stdio: "inherit" });
      rmSync(path);
      return directory;
    }
    offset = start + size + (size % 2);
  }
  throw new Error(`${deb} has no data archive`);
}

/** Copies a file out of an unpacked Debian package. */
function copyFromDeb(directory, from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(directory, from), to);
}

function step(label, started) {
  console.log(`[toolchain] ${label}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function main() {
  const started = Date.now();
  // Nothing already under .ci/ is an input: the checkout may carry files there, and the archives it could carry
  // are only accepted when their SHA-256 matches the pin.
  rmSync(toolchain, { recursive: true, force: true });
  rmSync(downloads, { recursive: true, force: true });
  mkdirSync(downloads, { recursive: true });
  let at = Date.now();
  const archives = new Map();
  for (const source of sources) archives.set(source.name, await download(source));
  step("downloads complete", at);

  const staging = join(ci, "toolchain-unpacked");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(toolchain, { recursive: true });

  at = Date.now();
  untar(archives.get(llvmArchive), staging);
  place(join(staging, "LLVM-22.1.8-Linux-X64"), join(toolchain, "llvm-22.1.8"));
  step("LLVM extracted", at);

  at = Date.now();
  untar(archives.get("zig-x86_64-linux-0.16.0.tar.xz"), staging);
  place(join(staging, "zig-x86_64-linux-0.16.0"), join(toolchain, "zig"));
  untar(archives.get("cmake-3.31.6-linux-x86_64.tar.gz"), staging);
  place(join(staging, "cmake-3.31.6-linux-x86_64"), join(toolchain, "cmake"));
  extractNinja(
    archives.get("ninja-1.13.2-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl"),
    join(toolchain, "ninja"),
  );
  step("Zig, CMake and Ninja installed", at);

  // The static LLVM helper links -lz and -lzstd. The image has the runtime libraries but no development files, so
  // the pinned Ubuntu packages supply the static archives and headers; run-lane puts the sysroot on the compilers'
  // LIBRARY_PATH and CPATH.
  at = Date.now();
  const sysroot = join(toolchain, "sysroot");
  const zlib = extractDeb(
    archives.get("zlib1g-dev_1.3.dfsg-3.1ubuntu2.3_amd64.deb"),
    join(staging, "zlib"),
  );
  for (const [from, to] of [
    ["usr/lib/x86_64-linux-gnu/libz.a", "lib/libz.a"],
    ["usr/include/zlib.h", "include/zlib.h"],
    ["usr/include/zconf.h", "include/zconf.h"],
  ])
    copyFromDeb(zlib, from, join(sysroot, to));
  const zstd = extractDeb(
    archives.get("libzstd-dev_1.5.5+dfsg2-2build1_amd64.deb"),
    join(staging, "zstd"),
  );
  for (const [from, to] of [
    ["usr/lib/x86_64-linux-gnu/libzstd.a", "lib/libzstd.a"],
    ["usr/include/zstd.h", "include/zstd.h"],
    ["usr/include/zstd_errors.h", "include/zstd_errors.h"],
  ])
    copyFromDeb(zstd, from, join(sysroot, to));
  step("zlib and zstd sysroot installed", at);

  for (const path of [
    "llvm-22.1.8/bin/llvm-config",
    "llvm-22.1.8/bin/clang",
    "llvm-22.1.8/lib/cmake/llvm/LLVMConfig.cmake",
    "zig/zig",
    "cmake/bin/cmake",
    "ninja/ninja",
    "sysroot/lib/libz.a",
    "sysroot/lib/libzstd.a",
    "sysroot/include/zlib.h",
    "sysroot/include/zstd.h",
  ])
    if (!existsSync(join(toolchain, path))) throw new Error(`.ci/toolchain is missing ${path}`);

  rmSync(staging, { recursive: true, force: true });
  writeFileSync(join(toolchain, ".revision"), `${revision}\n`);
  console.log(
    `.ci/toolchain installed (revision ${revision}) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}

await main();
