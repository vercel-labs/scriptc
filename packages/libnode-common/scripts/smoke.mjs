#!/usr/bin/env node
// Runs the libnode pack smoke test (smoke/smoke.c): compiles the C program
// with the host's C compiler, runs it against a pack directory and compares
// its stdout with the expected transcript, which pins the Node version,
// the built-in startup snapshot, full ICU, and synchronous, asynchronous
// and throwing calls through the bridge's C ABI.
//
//   node packages/libnode-common/scripts/smoke.mjs [--pack <dir>] [--platform <p>]
//
// The pack defaults to SCRIPTC_LIBNODE, else packages/libnode-<platform>.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bridgeAbi, bridgeHeader, commonRoot, readPin, repoRoot } from "./pin.mjs";

/** The host's pack platform name. */
export function hostPlatform() {
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  return `${process.platform}-${process.arch}-gnu`;
}

/** The transcript smoke.c prints for a correct pack of the pinned Node. */
export function expectedTranscript(pin = readPin(), abi = bridgeAbi()) {
  const icuSmall = pin.icu === "small";
  return [
    `bridge ABI ${abi}, Node ${pin.nodeVersion}, NODE_MODULE_VERSION ${pin.moduleVersion}`,
    "libnode mapped before dlopen: no",
    "1 + 2 => R3",
    `process.versions.node => R"${pin.nodeVersion}"`,
    "process.config.variables.node_use_node_snapshot => Rtrue",
    `process.config.variables.icu_small => R${icuSmall}`,
    `new Intl.NumberFormat('de-DE').format(1234567.891) => R"${icuSmall ? "1,234,567.891" : "1.234.567,891"}"`,
    `new Intl.DateTimeFormat('ja-JP', { timeZone: 'UTC', dateStyle: 'full' }).format(0) => R"${icuSmall ? "Thursday, January 1, 1970" : "1970年1月1日木曜日"}"`,
    `require('node:crypto').createHash('sha256').update('scriptc').digest('hex') => R"${sha256Hex("scriptc")}"`,
    `require('node:zlib').gunzipSync(require('node:zlib').gzipSync('round trip')).toString() => R"round trip"`,
    `[typeof require('node:fs').readFileSync, require('node:path').join('a', 'b')] => R["function","a/b"]`,
    `null.property => T{"error":{"name":"TypeError","message":"Cannot read properties of null (reading 'property')"}}`,
    `await new Promise((resolve) => setTimeout(() => resolve('timer fired'), 5)) => R"timer fired"`,
    "await require('node:fs/promises').readFile(process.execPath).then((b) => b.length > 0) => Rtrue",
    `await Promise.reject(new RangeError('rejected')) => T{"error":{"name":"RangeError","message":"rejected"}}`,
    "ok",
    "",
  ].join("\n");
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Compiles and runs the smoke test; returns its stdout and stderr. */
export function runSmoke(pack, cc = process.env.CC ?? "cc") {
  const work = mkdtempSync(join(tmpdir(), "scriptc-libnode-smoke-"));
  try {
    const binary = join(work, "smoke");
    execFileSync(
      cc,
      [
        "-std=c11",
        ...(process.platform === "linux" ? ["-D_POSIX_C_SOURCE=200809L", "-D_DEFAULT_SOURCE"] : []),
        "-O2",
        "-Wall",
        "-Werror",
        "-I",
        dirname(bridgeHeader),
        join(commonRoot, "smoke", "smoke.c"),
        ...(process.platform === "linux" ? ["-ldl"] : []),
        "-o",
        binary,
      ],
      { stdio: "inherit" },
    );
    const result = spawnSync(binary, [pack], { encoding: "utf8", env: { ...process.env } });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { pack: { type: "string" }, platform: { type: "string" } },
  });
  // An explicit --pack or --platform names the pack; SCRIPTC_LIBNODE only
  // replaces the host's default.
  const pack = resolve(
    values.pack ??
      (values.platform !== undefined
        ? join(repoRoot, "packages", `libnode-${values.platform}`)
        : (process.env.SCRIPTC_LIBNODE ?? join(repoRoot, "packages", `libnode-${hostPlatform()}`))),
  );
  const manifest = JSON.parse(readFileSync(join(pack, "manifest.json"), "utf8"));
  const { status, stdout, stderr } = runSmoke(pack);
  process.stderr.write(stderr);
  const expected = expectedTranscript();
  if (status !== 0 || stdout !== expected) {
    process.stderr.write(
      `smoke test failed (exit ${status}) for ${pack}\n--- expected\n${expected}--- actual\n${stdout}`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `libnode smoke test passed: ${manifest.package} (Node ${manifest.nodeVersion})\n`,
  );
}
