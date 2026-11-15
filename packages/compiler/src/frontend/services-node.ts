import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createComptimeEvaluator } from "./comptime.js";
import { FrontendServices, programHostLoads, type ComptimeEvaluator } from "./services.js";
import { hostIsMusl } from "./ts7/checker-backend.js";
import { Ts7Api, ts7Executable } from "./ts7/rpc-api.js";

/** The compile-time evaluator of the host's LLVM helper package, the package
 * every installation of the compiler carries for its host
 * (native/llvm-codegen/comptime). */
export function hostComptimeEvaluator(): string {
  const abi =
    process.platform === "linux"
      ? hostIsMusl()
        ? "-musl"
        : "-gnu"
      : process.platform === "win32"
        ? "-msvc"
        : "";
  const name = `@scriptc/llvm-${process.platform}-${process.arch}${abi}`;
  let root: string;
  try {
    root = dirname(createRequire(import.meta.url).resolve(`${name}/package.json`));
  } catch {
    throw new Error(
      `the compile-time evaluator's package ${name} is not installed; reinstall scriptc with optional dependencies enabled for this host`,
    );
  }
  const executable = join(
    root,
    "bin",
    process.platform === "win32" ? "scriptc-comptime.exe" : "scriptc-comptime",
  );
  if (!existsSync(executable))
    throw new Error(
      `the compile-time evaluator ${executable} is missing; reinstall scriptc, or build ${name} with its build:native script`,
    );
  return executable;
}

/** The Node host's evaluator. Nothing is resolved until a program's first
 * `comptime` call. */
function nodeComptimeEvaluator(): ComptimeEvaluator {
  let evaluate: ComptimeEvaluator | undefined;
  return (source, limits, siblings) =>
    (evaluate ??= createComptimeEvaluator(ts7Executable(), hostComptimeEvaluator))(
      source,
      limits,
      siblings,
    );
}

export function createNodeFrontendServices(): FrontendServices {
  return new FrontendServices(
    (options) => new Ts7Api(options),
    process.cwd(),
    nodeComptimeEvaluator(),
    {
      resolve: (fromFile, specifier, paths) => {
        const require = createRequire(pathToFileURL(fromFile));
        return paths === undefined
          ? require.resolve(specifier)
          : require.resolve(specifier, { paths: [...paths] });
      },
      lookupPaths: (fromFile, specifier) =>
        createRequire(pathToFileURL(fromFile)).resolve.paths(specifier),
    },
  );
}

let shared: FrontendServices | undefined;
/** Standalone Node utilities share a lazy parser whose transport closes at
 * process exit. Compilation loads create and dispose their own services. */
export function nodeFrontendServices(): FrontendServices {
  return (shared ??= createNodeFrontendServices());
}

/** The services of the compile in progress: one build loads the program more
 * than once (the island decision reloads it, and each island retry round
 * loads it again), and services created per load start a cold checker for
 * every one of them. A build opens one scope around its whole frontend work
 * (beginCompileServices) and the loads share it. */
let compileServices: FrontendServices | null = null;
let compileScopes = 0;

/** The services the compile in progress shares, opened for `one` scope. The
 * last scope to end closes them, so nothing outlives a build. */
export function beginCompileServices(): FrontendServices {
  if (compileServices === null) {
    const services = createNodeFrontendServices();
    services.reuseProgramHosts(programHostLoads());
    compileServices = services;
  }
  compileScopes += 1;
  return compileServices;
}

export function endCompileServices(services: FrontendServices): void {
  if (compileScopes > 0) compileScopes -= 1;
  if (compileScopes > 0 || compileServices !== services) return;
  compileServices = null;
  services.close();
}

/** The compile in progress's services, or null outside a compile (a frontend
 * then creates its own). */
export function compileFrontendServices(): FrontendServices | null {
  return compileServices;
}
