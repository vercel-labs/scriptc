#!/usr/bin/env node
// Fast pre-merge check for the relocated runtime sources.
//
// The native CLI ships packages/runtime as `lib/runtime-sources/{src,vendor}`
// (scripts/native-cli-assets.mts), and the sanitizer, executable and
// runtime-pack builds each compile those sources with their own include list.
// A source that includes a header one of those lists does not carry compiles
// nowhere: a missing `ssl_misc.h` failed the merge queue only 80 minutes into
// a relocated rebuild-emit run, while the same mistake is a syntax-only parse
// away in seconds.
//
// This script rebuilds the relocated layout in a temporary directory and runs
// `clang -fsyntax-only` over the runtime sources with every include list the
// three builds use:
//
//   runtime-pack  per-source vendor include (build.mjs's includeFlags)
//   executable    the union of the executable lane's unit includes
//   sanitizer     the executable union plus ASan / RC-audit defines
//
// It needs a C compiler and nothing else: no build, no artifacts, no network.
// The preflight and the code_quality job run it right after lint.
//
// usage: node scripts/check-relocated-runtime-headers.mjs [--require-compiler]
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  globSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const runtimeRoot = join(repoRoot, "packages/runtime");
const runtimeSrc = join(runtimeRoot, "src");
const vendorRoot = join(runtimeRoot, "vendor");

/** The C compiler. The native builds use `CC` (often `zig cc`); any driver
 * that speaks clang's flags works here. */
function compilerCommand() {
  const configured = process.env["CC"] ?? process.env["SCRIPTC_CC"];
  const words = configured === undefined ? ["clang"] : configured.split(/\s+/).filter(Boolean);
  return { command: words[0], prefix: words.slice(1) };
}

const vendor = {
  quickjs: join(vendorRoot, "quickjs-ng"),
  mbedtls: join(vendorRoot, "mbedtls"),
  zlib: join(vendorRoot, "zlib"),
  brotli: join(vendorRoot, "brotli", "c"),
  zstd: join(vendorRoot, "zstd"),
  sqlite: join(vendorRoot, "sqlite"),
  mlkem: join(vendorRoot, "mlkem-native"),
};

/** ICU is not vendored. The caches hold a fetched release as
 * `<cache>/icu4c-<version>-source/source/{common,i18n}` (the runtime-pack
 * build's node_modules cache and the compiler's vendor cache); an installed
 * pack holds the headers scr_intl.c includes under
 * `artifacts/vendor/icu/include/unicode`. Returns { dirs, where } or null. */
function icuIncludeDirs() {
  const vendorCache = process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
  const sourceTrees = [
    ...globSync(join(repoRoot, "node_modules/.cache/scriptc-icu-sources/icu4c-*-source/source")),
    ...globSync(join(repoRoot, "packages/runtime/vendor/.cache/icu4c-*-source/source")),
    ...(vendorCache === undefined ? [] : globSync(join(vendorCache, "icu4c-*-source/source"))),
  ];
  for (const source of sourceTrees.sort()) {
    if (existsSync(join(source, "common/unicode/utypes.h")))
      return { dirs: [join(source, "common"), join(source, "i18n")], where: source };
  }
  const includeRoots = globSync(join(repoRoot, "packages/runtime-*/artifacts/vendor/icu/include"));
  for (const include of includeRoots.sort()) {
    if (existsSync(join(include, "unicode/ubrk.h"))) return { dirs: [include], where: include };
  }
  return null;
}

/** The runtime sources the runtime-pack build compiles, grouped by the
 * per-source vendor include its includeFlags give them. Files without a
 * vendor include share the default group. */
function packGroups(sources, icu) {
  const special = new Map([
    ["scr_regex.c", { name: "quickjs", includes: [vendor.quickjs] }],
    ...[
      "scr_tls.c",
      "scr_cipher.c",
      "scr_ecdh.c",
      "scr_dh.c",
      "scr_pki.c",
      "scr_webcrypto_aes.c",
    ].map((name) => [name, { name: "mbedtls", includes: [join(vendor.mbedtls, "include")] }]),
    ["scr_zlib.c", { name: "zlib", includes: [vendor.zlib] }],
    ["scr_fetch.c", { name: "zlib", includes: [vendor.zlib] }],
    ["scr_brotli.c", { name: "brotli", includes: [join(vendor.brotli, "include")] }],
    ["scr_zstd.c", { name: "zstd", includes: [join(vendor.zstd, "lib")] }],
    ["scr_sqlite.c", { name: "sqlite", includes: [vendor.sqlite] }],
  ]);
  if (icu !== null) special.set("scr_intl.c", { name: "icu", includes: icu.dirs });
  const groups = new Map([["default", []]]);
  for (const source of sources) {
    const group = special.get(source);
    if (group === undefined) {
      groups.get("default").push(source);
    } else {
      const key = group.name;
      if (!groups.has(key)) groups.set(key, { includes: group.includes, sources: [] });
      groups.get(key).sources.push(source);
    }
  }
  return [...groups].map(([name, group]) =>
    Array.isArray(group)
      ? { name, includes: [], sources: group }
      : { name, includes: group.includes, sources: group.sources },
  );
}

/** The executable lane passes every selected unit's include flags to one
 * clang command, so its include list is the union of all of them; the
 * sanitizer lane compiles the same units with the same includes. */
function unionIncludes(icu) {
  return [
    vendor.quickjs,
    join(vendor.mbedtls, "include"),
    vendor.zlib,
    join(vendor.brotli, "include"),
    join(vendor.zstd, "lib"),
    vendor.sqlite,
    vendor.mlkem,
    join(vendor.mlkem, "src"),
    ...(icu?.dirs ?? []),
  ];
}

/** The executable lane's optional compile-time definitions (RUNTIME_DEFINES
 * in native/executable.ts) plus SCR_WORKERS: each one switches on code that
 * may name another header, so the check compiles the union. */
const RUNTIME_DEFINES = [
  "SCR_TEXT_DECODER_LEGACY",
  "SCR_WARNING_REPLACE",
  "SCR_PROMISE_REJECT_DYN",
  "SCR_GLOBAL_HOST_ABSENT",
  "SCR_JS_OBJECT_MODEL",
  "SCR_PROCESS_EXTRAS",
  "SCR_NET_SERVER_OFF",
  "SCR_HTTP_SERVER_META",
  "SCR_FS_FLAGS",
  "SCR_DYN_PROMISE_KEYS",
  "SCR_FN_MEMBER_PROPS",
  "SCR_CHILD_CP_OPTIONS",
  "SCR_STREAM_WRITE_ERRORS",
  "SCR_FS_STREAM_SIGNAL",
  "SCR_HANDLE_CLASSES",
  "SCR_WEB_BODIES",
  "SCR_YIN",
  "SCR_CHILD_ERR_FIELDS",
  "SCR_CHILD_STREAM_FLOW",
  "SCR_NODE_ISLANDS",
  "SCR_NODE_ISLAND_STDIO",
  "SCR_TTY_COLORS",
  "SCR_WORKERS",
];

const commonFlags = ["-fsyntax-only", "-std=c11", "-D_GNU_SOURCE", "-pthread"];

function run(compiler, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(compiler.command, [...compiler.prefix, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ status: 127, stdout: "", stderr: String(error) }));
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });
}

async function main() {
  const requireCompiler = process.argv.includes("--require-compiler");
  const compiler = compilerCommand();
  const probe = await run(compiler, ["--version"], repoRoot);
  if (probe.status !== 0) {
    const message = `relocated runtime headers: no usable C compiler (${compiler.command}):\n${probe.stderr.trim()}`;
    if (requireCompiler) {
      console.error(message);
      process.exit(1);
    }
    console.log(`${message}\ninstall clang to run this check; skipped`);
    return;
  }

  const icu = icuIncludeDirs();
  // Say so when scr_intl.c is skipped: a cache path that stops matching the
  // fetcher's layout must not silently reduce the check to the other sources.
  if (icu === null)
    console.log(
      "relocated runtime headers: no ICU source cache or installed pack headers found; scr_intl.c is not checked",
    );
  const scratch = mkdtempSync(join(tmpdir(), "scriptc-relocated-headers-"));
  try {
    // The relocation itself: the shipped layout is lib/runtime-sources/
    // {src,vendor} beside the binary. Symlinks keep the check fast; include
    // resolution (quote includes first search the source's directory, then
    // -I) is the same as with a copy.
    const relocated = join(scratch, "lib/runtime-sources");
    cpSync(runtimeSrc, join(relocated, "src"), { recursive: true });
    symlinkSync(vendorRoot, join(relocated, "vendor"), "dir");
    const relocatedSrc = join(relocated, "src");

    // The unit tests (*.test.c) are not part of any build's source list.
    const sources = readdirSync(relocatedSrc)
      .filter((name) => name.endsWith(".c") && !name.endsWith(".test.c"))
      .sort();
    // scr_intl.c is compiled only by builds that ship ICU (the linux-x64-gnu
    // pack and an executable built with the Intl option). Without its headers
    // there is no include list to check it against.
    const checked = sources.filter((name) => icu !== null || name !== "scr_intl.c");
    const allSources = checked.map((name) => join(relocatedSrc, name));
    const union = unionIncludes(icu);
    const groups = [
      ...packGroups(checked, icu).map((group) => ({
        label: `runtime-pack ${group.name}`,
        flags: ["-I", relocatedSrc, ...group.includes.flatMap((dir) => ["-I", dir])],
        sources: group.sources.map((name) => join(relocatedSrc, name)),
      })),
      {
        label: "executable",
        flags: [
          "-I",
          relocatedSrc,
          ...union.flatMap((dir) => ["-I", dir]),
          ...RUNTIME_DEFINES.map((define) => `-D${define}`),
        ],
        sources: allSources,
      },
      {
        label: "sanitizer",
        flags: [
          "-I",
          relocatedSrc,
          ...union.flatMap((dir) => ["-I", dir]),
          ...RUNTIME_DEFINES.map((define) => `-D${define}`),
          "-DSCR_RC_AUDIT",
          "-O1",
          "-fsanitize=address",
        ],
        sources: allSources,
      },
    ];

    const started = Date.now();
    const failures = [];
    await Promise.all(
      groups.map(async (group) => {
        const result = await run(
          compiler,
          [...commonFlags, ...group.flags, ...group.sources],
          scratch,
        );
        if (result.status !== 0)
          failures.push({
            label: group.label,
            output: result.stderr.trim() || result.stdout.trim(),
          });
      }),
    );
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (failures.length > 0) {
      console.error(
        "relocated runtime headers: the runtime does not parse with a build's include list",
      );
      for (const failure of failures) console.error(`\n[${failure.label}]\n${failure.output}`);
      process.exit(1);
    }
    console.log(
      `relocated runtime headers: ${checked.length} sources parsed by ${groups.length} build include lists in ${seconds}s`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main();
