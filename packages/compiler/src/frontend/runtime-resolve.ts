/* Node runtime resolution used by compile-time-folded module introspection.
 *
 * This is deliberately separate from resolve.ts: that resolver answers the
 * TypeScript program's TYPE surface and may correctly select a .d.ts file,
 * while import.meta.resolve / require.resolve must answer Node's executable
 * file or URL. Native CJS resolution uses the shared filesystem resolver,
 * including exact exports/imports targets and legacy extension/index probes;
 * a Node host supplies its resolver to preserve process settings and hooks. ESM
 * package success uses the tracked embedded-graph resolver under Node's import
 * conditions; relative and URL-like specifiers are pure URL resolution and do
 * not require the target to exist, matching Node. */

import { isBuiltin } from "node:module";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { markFrontendInputsUnstable } from "./input-tracker.js";
import { NodePackageResolver, probeNodeImportRefusal } from "./npm.js";
import type { FrontendServices } from "./services.js";
import { wasiGuestPath } from "../wasi-paths.js";
import { cjsResolvePaths, resolveCjsRuntime } from "./cjs-resolve.js";

export interface RuntimeResolveError {
  name: string;
  code: string;
  message: string;
}

export type RuntimeResolveResult =
  | { ok: true; value: string }
  | { ok: false; error: RuntimeResolveError };

function errorShape(error: unknown): RuntimeResolveError {
  const e = error as { name?: unknown; code?: unknown; message?: unknown };
  return {
    name: typeof e?.name === "string" ? e.name : "Error",
    code: typeof e?.code === "string" ? e.code : "",
    message: typeof e?.message === "string" ? e.message : String(error),
  };
}

export function runtimePathForTarget(path: string, targetPlatform: string): string {
  if (targetPlatform !== "wasi") return path;
  return wasiGuestPath(path) ?? path.replaceAll("\\", "/");
}

function targetFileUrl(path: string, targetPlatform: string): string {
  return pathToFileURL(runtimePathForTarget(path, targetPlatform), {
    windows: targetPlatform === "win32",
  }).href;
}

function urlLike(specifier: string): boolean {
  return /^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier);
}

/** import.meta.resolve for a static string and the containing source file.
 * Package-import (`#name`) resolution remains a named lowering fence until
 * its Node error/success path can share the package-import resolver without
 * crossing back into TypeScript's declaration-file answer. */
export function resolveImportMetaRuntime(
  fromFile: string,
  specifier: string,
  targetPlatform: string,
  services?: FrontendServices,
): RuntimeResolveResult | null {
  const base = targetFileUrl(fromFile, targetPlatform);
  if (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    isAbsolute(specifier) ||
    urlLike(specifier)
  ) {
    try {
      return { ok: true, value: new URL(specifier, base).href };
    } catch (error) {
      return { ok: false, error: errorShape(error) };
    }
  }
  if (isBuiltin(specifier)) {
    return { ok: true, value: specifier.startsWith("node:") ? specifier : `node:${specifier}` };
  }
  if (specifier.startsWith("#")) return null;

  if (services === undefined)
    throw new Error("package runtime resolution requires frontend services");
  const builder = new NodePackageResolver();
  const key = builder.resolveForIntrospection(fromFile, specifier, "import");
  if (key !== null) return { ok: true, value: targetFileUrl(key, targetPlatform) };
  const refusal = probeNodeImportRefusal(fromFile, specifier);
  if (refusal !== null) {
    return {
      ok: false,
      error: { name: "Error", code: refusal.code, message: refusal.message },
    };
  }
  return null;
}

/* What a build-time require.resolve depends on. The compiler's own resolver
 * (cjs-resolve.ts) asks the tracked filesystem about every candidate, and
 * records the host facts its legacy global lookup locations come from (the
 * home directory, NODE_PATH, the compiler's installation prefix), so the
 * frontend's input snapshot is complete and its result can be cached. A
 * resolver the host supplies looks where it likes (its own global paths,
 * loader hooks, its module cache) and reports none of it: a build that
 * consults one declines cache publication. */
const HOST_RESOLVER =
  "a require.resolve call was answered by the host's module resolver, which does not report what it read";

/** require.resolve under the containing file's CommonJS resolver. */
export function resolveRequireRuntime(
  fromFile: string,
  specifier: string,
  targetPlatform: string,
  paths?: readonly string[],
  services?: FrontendServices,
): RuntimeResolveResult {
  const resolver = services?.runtimeModuleResolver;
  if (resolver !== undefined) markFrontendInputsUnstable(HOST_RESOLVER);
  try {
    const result: RuntimeResolveResult =
      resolver === undefined
        ? resolveCjsRuntime(fromFile, specifier, paths)
        : { ok: true, value: resolver.resolve(fromFile, specifier, paths) };
    if (!result.ok) return result;
    return {
      ok: true,
      value: isAbsolute(result.value)
        ? runtimePathForTarget(result.value, targetPlatform)
        : result.value,
    };
  } catch (error) {
    return { ok: false, error: errorShape(error) };
  }
}

/** require.resolve.paths under the containing file's CommonJS resolver. */
export function requireResolvePathsRuntime(
  fromFile: string,
  specifier: string,
  targetPlatform: string,
  services?: FrontendServices,
): readonly string[] | null | RuntimeResolveError {
  const resolver = services?.runtimeModuleResolver;
  if (resolver !== undefined) markFrontendInputsUnstable(HOST_RESOLVER);
  try {
    const paths =
      resolver === undefined
        ? cjsResolvePaths(fromFile, specifier)
        : resolver.lookupPaths(fromFile, specifier);
    return paths?.map((path) => runtimePathForTarget(path, targetPlatform)) ?? null;
  } catch (error) {
    return errorShape(error);
  }
}
