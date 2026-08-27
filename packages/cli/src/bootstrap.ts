#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { enableCompileCache } from "node:module";
import { arch } from "node:process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CLI_OPTIONS, USAGE } from "./usage.js";

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
    return (JSON.parse(requireText(join(here, "..", "package.json"))) as { version?: string }).version ?? "unknown";
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
  let parsed: ReturnType<typeof parseArgs<{ options: typeof CLI_OPTIONS; allowPositionals: true; allowNegative: true }>>;
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
  if (
    (command !== "build" && command !== "run") || inputArg === undefined ||
    (values.emit !== undefined && values.emit !== "exe") ||
    values.print !== undefined ||
    values["emit-ir"] ||
    values.lib || values["from-c"] || values["provenance-sources"] ||
    (values["external-types"] ?? []).length > 0
  ) return null;
  const backend = values.backend;
  if (backend !== undefined && backend !== "c" && backend !== "llvm") return null;
  const optimization = values.optimization;
  if (optimization !== undefined && optimization !== "release" && optimization !== "dev") return null;
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
  let driver: ReturnType<typeof import("@scriptc/compiler/startup-cache")["resolveCc"]>;
  try {
    startup = await import("@scriptc/compiler/startup-cache");
    driver = startup.resolveCc();
  } catch {
    return null;
  }
  const buildPlatform = startup.targetPlatform(driver);
  if (command === "run" && buildPlatform === "wasi") return null;
  const input = resolve(inputArg);
  const outDir = values.out ? dirname(resolve(values.out)) : join(dirname(input), ".scriptc");
  const stem = basename(input).replace(/\.(ts|mts|cts|js|mjs|cjs|c|ll)$/, "");
  const defaultName = buildPlatform === "win32"
    ? `${stem}.exe`
    : buildPlatform === "wasi"
      ? `${stem}.wasm`
      : stem;
  const outPath = values.out ? resolve(values.out) : join(outDir, defaultName);
  const ffiPath = values.ffi === undefined ? null : resolve(values.ffi);
  const ffiBytes = ffiPath === null ? null : await readFile(ffiPath).catch(() => null);
  if (ffiPath !== null && ffiBytes === null) return null;
  const root = await startup.prepareBuildCacheRoot(startup.resolveBuildCacheRoot());
  const nativeEnvironment = await startup.executableNativeEnvironmentFingerprint().catch(() => null);
  if (nativeEnvironment === null) return null;
  const hit = await startup.readRoutedExecutableCache(root, {
    entryPath: input,
    outDir,
    outPath,
    emitIr: values["emit-ir"],
    sanitize: values.sanitize,
    dynamic: values.dynamic,
    backend: backend ?? "auto",
    ...(optimization === "dev" ? { optimization: "dev" as const } : {}),
    npmStatic,
    ffiProfile: ffiPath === null ? null : { path: ffiPath, bytes: ffiBytes! },
    target: `${process.env["SCRIPTC_TARGET"] ?? "native"}:${buildPlatform}:${arch}:${
      process.platform === "darwin" && arch === "arm64" &&
      (process.env["SCRIPTC_TARGET"] ?? "") === "" &&
      backend !== "c" && !values.sanitize &&
      process.env["SCRIPTC_RUNTIME_PACK"] !== "0" &&
      process.env["SCRIPTC_FETCH_CURL"] !== "1" &&
      ((process.env["SCRIPTC_CC"] ?? "") === "" || process.env["SCRIPTC_CC"] === "clang")
        ? "runtime-pack"
        : "driver-tu"
    }`,
    compiler: [process.env["SCRIPTC_LINKER"] ?? process.env["SCRIPTC_CC"] ?? "clang"],
    nativeEnvironment,
    nodeVersion: process.version,
  });
  if (hit === null) return null;
  if (hit.native.llvmRefusal !== undefined) {
    process.stderr.write(`scriptc: backend c (llvm refused: ${hit.native.llvmRefusal})\n`);
  }
  // Source-primary invocations can replace a previously cached executable.
  // A routed hit restores that executable without loading the full compiler,
  // so mirror its output-kind cleanup before returning from the fast path.
  await rm(join(outDir, `${stem}.ir.json`), { force: true });
  if (!values["keep-c"]) await rm(hit.cPath, { force: true });
  if (command === "build") {
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

const fastExit = await tryFastPath();
if (fastExit === null) {
  await import("./main.js");
} else {
  process.exitCode = fastExit;
}
