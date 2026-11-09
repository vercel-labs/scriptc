#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { enableCompileCache } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CLI_FAST_PATHS, CLI_OPTIONS, firstCliOptionOutside, USAGE } from "./usage.js";

// Node 24 can persist V8's compiled module bytecode. scriptc's CLI imports
// the compiler and its lowering/backend graph before handling any command, so
// enabling this in the tiny bootstrap avoids reparsing that graph on every
// edit/build invocation.
try {
  enableCompileCache();
} catch {
  // Bytecode caching is an optimization boundary. A read-only temp directory
  // must never prevent the compiler from running.
}

function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    return (
      (JSON.parse(requireText(join(here, "..", "package.json"))) as { version?: string }).version ??
      "unknown"
    );
  } catch {
    return "unknown";
  }
}

function requireText(path: string): string {
  // This tiny synchronous read keeps --version free of the compiler graph and
  // preserves the package manifest as the one release-version authority.
  const { readFileSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  return readFileSync(path, "utf8");
}

async function tryFastPath(): Promise<number | null> {
  let parsed: ReturnType<
    typeof parseArgs<{ options: typeof CLI_OPTIONS; allowPositionals: true; allowNegative: true }>
  >;
  try {
    parsed = parseArgs({ options: CLI_OPTIONS, allowPositionals: true, allowNegative: true });
  } catch {
    return null; // main owns exact user-error wording
  }
  const { values, positionals } = parsed;
  if (values.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }
  const [command, inputArg] = positionals;
  if (command === "coverage") return coverageFastPath(values, inputArg, positionals.length);
  // Computed-access sites emit different code by default; an explicit value
  // other than "1" is an opt-out or one the full compiler validates
  // (backend/llvm/js-ic.ts).
  const indexFastpath = process.env["SCRIPTC_DYN_INDEX_FASTPATH"];
  if (
    (command !== "build" && command !== "run") ||
    inputArg === undefined ||
    // The route below keys or handles these options only. The full CLI owns
    // every other one: it uses the option or refuses it.
    firstCliOptionOutside(values, CLI_FAST_PATHS.executable.options) !== undefined ||
    (values.emit !== undefined && values.emit !== "exe") ||
    // A --libnode=beside build places the pack and the island modules next
    // to the executable, which a routed hit does not do.
    values.libnode === "beside" ||
    // The full compiler writes the representation report and keys the heap
    // census build (backend/llvm/repr-report.ts, heap-census.ts).
    (process.env["SCRIPTC_REPR_REPORT"] ?? "") !== "" ||
    (process.env["SCRIPTC_HEAP_CENSUS"] ?? "") !== "" ||
    // An attribution build emits a different way count, and the full compiler
    // keys the build by it (backend/llvm/js-ic.ts).
    (process.env["SCRIPTC_DEBUG_JS_IC_WAYS"] ?? "") !== "" ||
    (indexFastpath !== undefined && indexFastpath !== "" && indexFastpath !== "1")
  )
    return null;
  const backend = values.backend;
  if (backend !== undefined && backend !== "llvm") return null;
  const optimization = values.optimization;
  if (
    optimization !== undefined &&
    optimization !== "release" &&
    optimization !== "dev" &&
    optimization !== "speed"
  )
    return null;
  const npmRaw = (values["npm-static"] ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");
  let npmStatic: string[] | "auto" | null = null;
  if (npmRaw.includes("auto")) {
    if (npmRaw.length !== 1) return null;
    npmStatic = "auto";
  } else if (npmRaw.length > 0) {
    npmStatic = npmRaw;
  }

  let startup: typeof import("@scriptc/compiler/startup-cache");
  let buildPlatform: string;
  try {
    startup = await import("@scriptc/compiler/startup-cache");
    buildPlatform = startup.configuredTargetPlatform();
  } catch {
    return null;
  }
  if (command === "run" && buildPlatform === "wasi") return null;
  const input = resolve(inputArg);
  const outDir = values.out ? dirname(resolve(values.out)) : join(dirname(input), ".scriptc");
  const stem = basename(input).replace(/\.(ts|mts|cts|js|mjs|cjs|c|ll)$/, "");
  const defaultName =
    buildPlatform === "win32" ? `${stem}.exe` : buildPlatform === "wasi" ? `${stem}.wasm` : stem;
  const outPath = values.out ? resolve(values.out) : join(outDir, defaultName);
  const ffiPath = values.ffi === undefined ? null : resolve(values.ffi);
  const ffiBytes = ffiPath === null ? null : await readFile(ffiPath).catch(() => null);
  if (ffiPath !== null && ffiBytes === null) return null;
  const root = await startup.prepareBuildCacheRoot(startup.resolveBuildCacheRoot());
  // This must exactly mirror the ordinary LLVM executable's route in the
  // full compiler. Otherwise a valid helper/runtime-pack cache entry has a
  // different target/compiler identity and bootstrap must unnecessarily load
  // the whole compiler graph to rediscover it.
  const helperRuntimePackTarget = !values.sanitize ? startup.precompiledRuntimePackTarget() : null;
  const helperObjectRoute = helperRuntimePackTarget !== null;
  // The full compiler reports a checker it cannot find.
  let checker: string | undefined;
  try {
    checker = startup.checkerCacheIdentity();
  } catch {
    return null;
  }
  const hit = await startup.readRoutedExecutableCache(root, {
    entryPath: input,
    outDir,
    outPath,
    emitIr: false,
    sanitize: values.sanitize,
    backend: "llvm",
    ...(optimization === "dev" || optimization === "speed" ? { optimization } : {}),
    ...(values.strip ? { strip: true as const } : {}),
    ...(values.static ? { staticLink: true as const } : {}),
    ...(values["detached-exit"] ? { detachedExit: true as const } : {}),
    ...(values["large-pages"] ? { largePages: true as const } : {}),
    ...(values["cpu-dispatch"] === true ? { cpuDispatch: true as const } : {}),
    ...(checker === undefined ? {} : { checker }),
    npmStatic,
    // Only builds with the computed-access shape reach this route, and the
    // full compiler keys those builds by it (backend/llvm/js-ic.ts).
    dynIndexFastpath: true as const,
    // Mirrors the full compiler's key: shape inference's overlay is opt-in
    // (SCRIPTC_SHAPE_OVERLAY=1) and --no-shape-overlay turns it off.
    ...(process.env["SCRIPTC_SHAPE_OVERLAY"] === "1" && values["shape-overlay"] !== false
      ? { shapeOverlay: true as const }
      : {}),
    ffiProfile: ffiPath === null ? null : { path: ffiPath, bytes: ffiBytes! },
    target: `${process.env["SCRIPTC_TARGET"] ?? "native"}:${buildPlatform}:${process.arch}:${
      helperObjectRoute ? "runtime-pack" : "driver-tu"
    }`,
    compiler: [
      helperObjectRoute
        ? startup.resolvePlatformLinker(process.env, helperRuntimePackTarget.defaultLinker)
        : (process.env["SCRIPTC_CC"] ?? "clang"),
    ],
    nativeEnvironment: () =>
      helperObjectRoute
        ? startup.executableLinkerEnvironmentFingerprint(
            process.env,
            helperRuntimePackTarget.defaultLinker,
          )
        : startup.executableNativeEnvironmentFingerprint(),
    nodeVersion: process.version,
    // An entry of a program that calls into Node.js serves only the same pack.
    libnodeIdentity: () => startup.libnodeCacheKey(values.libnode, process.env, dirname(input)),
  });
  if (hit === null) return null;
  // A restored executable links nothing, so the ICU data file its Intl
  // program reads at run time was not installed beside it; the full compiler
  // restores the same executable and installs that file.
  if (hit.native.intl === true) return null;
  // A cached build repeats every warning it reported. This path renders the
  // performance warning itself (SC6101 needs no source frames); a hit that
  // holds any other warning — a divergence, a Node island note, a type patch —
  // takes the full compiler, which renders it as the cold build does.
  const cachedWarnings = hit.warnings ?? [];
  if (command === "build" && cachedWarnings.some((d) => !startup.isPerformanceCode(d.code)))
    return null;
  if (!values["keep-llvm"]) await rm(hit.llvmPath, { force: true });
  if (command === "build") {
    const performance =
      values["dynamic-tier-warning"] === false
        ? []
        : cachedWarnings.filter((d) => startup.isPerformanceCode(d.code));
    if (performance.length > 0)
      process.stderr.write(startup.renderPerformanceWarnings(performance) + "\n");
    process.stdout.write(`${outPath}\n`);
    return 0;
  }
  return new Promise<number>((resolveExit) => {
    const child = spawn(outPath, [], { stdio: "inherit" });
    child.on("exit", (code, signal) => {
      if (signal) {
        process.stderr.write(`scriptc: program killed by ${signal}\n`);
        resolveExit(1);
      } else {
        resolveExit(code ?? 0);
      }
    });
  });
}

/** An unchanged program's coverage verdict replays from the verdict cache
 * without loading the compiler graph. Anything else (a miss, a comment-only
 * edit, options the replay does not cover) defers to the full CLI. */
async function coverageFastPath(
  values: ReturnType<
    typeof parseArgs<{ options: typeof CLI_OPTIONS; allowPositionals: true; allowNegative: true }>
  >["values"],
  inputArg: string | undefined,
  positionalCount: number,
): Promise<number | null> {
  const print = values.print;
  const failOn = values["fail-on"];
  if (
    inputArg === undefined ||
    positionalCount !== 2 ||
    // The replay is the verdict of the default analysis. The full CLI owns
    // every option that changes the analysis or the report, and every one it
    // refuses.
    firstCliOptionOutside(values, CLI_FAST_PATHS.coverage.options) !== undefined ||
    (print !== undefined && print !== "diagnostics") ||
    (failOn !== undefined && failOn !== "blockers" && failOn !== "divergences") ||
    // `--coverage=reached` keys its own verdicts; any other value is the
    // full CLI's to validate.
    (values.coverage !== undefined &&
      values.coverage !== "full" &&
      values.coverage !== "reached") ||
    // --fail-on=divergences checks the warnings --no-copy-warning and
    // --no-key-order-warning leave out: the full CLI refuses either pair,
    // and a replayed verdict must not pass it.
    (failOn === "divergences" &&
      (values["copy-warning"] === false || values["key-order-warning"] === false))
  )
    return null;
  let startup: typeof import("@scriptc/compiler/startup-cache");
  try {
    startup = await import("@scriptc/compiler/startup-cache");
  } catch {
    return null;
  }
  const hit = await startup
    .readCoverageVerdict(
      resolve(inputArg),
      values.coverage === "reached" ? { coverage: "reached" } : {},
    )
    .catch(() => null);
  if (hit === null) return null;
  const { coverage, sourceTexts } = hit;
  if (values["dynamic-tier-warning"] === false) delete coverage.performance;
  if (values["copy-warning"] === false && coverage.divergences !== undefined)
    coverage.divergences = coverage.divergences.filter((d) => d.code !== "SC6001");
  if (values["key-order-warning"] === false && coverage.divergences !== undefined)
    coverage.divergences = coverage.divergences.filter((d) => d.code !== "SC6014");
  if (print === "diagnostics") {
    const envelope = startup.coverageEnvelope(coverage, {
      compilerVersion: packageVersion(),
      sourceTexts,
      ...(failOn === undefined ? {} : { failOn }),
    });
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    const color = process.stdout.isTTY ?? false;
    process.stdout.write(
      startup.renderCoverage(coverage, { color, sourceTexts, root: process.cwd() }) + "\n",
    );
  }
  return startup.coveragePasses(coverage, failOn) ? 0 : 1;
}

const fastExit = await tryFastPath();
if (fastExit === null) {
  await import("./main.js");
} else {
  process.exitCode = fastExit;
}
