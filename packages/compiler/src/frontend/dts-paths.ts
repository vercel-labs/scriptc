import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { npmPackageNameOf } from "./workspace-registry.js";
import { tsgoPath } from "./ts7/session-path.js";

export { tsgoPath } from "./ts7/session-path.js";

const require = createRequire(import.meta.url);
let installedDeclarationRoot: string | null = null;
/** The paths `declarationPath` answered, by name, for the current root.
 * Lowering asks for them once per mapped type (isFallbackDtsPath), and each
 * answer without an installed root costs a package resolution. */
const declarationPaths = new Map<string, string>();

/** A native distribution supplies its relocatable declaration directory. */
export function setDeclarationRoot(root: string): void {
  installedDeclarationRoot = root;
  declarationPaths.clear();
}

function declarationPath(name: string): string {
  let path = declarationPaths.get(name);
  if (path === undefined) {
    path = resolveDeclarationPath(name);
    declarationPaths.set(name, path);
  }
  return path;
}

function resolveDeclarationPath(name: string): string {
  return tsgoPath(
    installedDeclarationRoot === null
      ? name === "scriptc.d.ts"
        ? require.resolve("@scriptc/compiler/scriptc.d.ts")
        : name === "scriptc-overrides.d.ts"
          ? require.resolve("@scriptc/compiler/scriptc-overrides.d.ts")
          : name === "scriptc-node-fallback.d.ts"
            ? require.resolve("@scriptc/compiler/scriptc-node-fallback.d.ts")
            : join(dirname(require.resolve("@scriptc/compiler/scriptc-node-fallback.d.ts")), name)
      : join(installedDeclarationRoot, name),
  );
}

/** Directory of the shipped package shims (packages/compiler/shims): the
 * implementation modules package-shims.ts maps npm packages to. A native
 * distribution ships them beside its declarations. */
export function packageShimRoot(): string {
  return installedDeclarationRoot === null
    ? join(dirname(require.resolve("@scriptc/compiler/scriptc.d.ts")), "..", "shims")
    : join(installedDeclarationRoot, "shims");
}

/** The directories of files scriptc itself ships, each with the prefix
 * that names its files independently of where scriptc is installed
 * (compilerOwnedFileName). IR artifacts spell source locations in them this
 * way (serializeModuleParts). */
export function compilerOwnedFileRoots(): readonly { from: string; to: string }[] {
  return [{ from: tsgoPath(packageShimRoot()) + "/", to: "scriptc:shims/" }];
}

/** The name of a file scriptc itself ships (a package shim or one of the
 * shipped declaration files) that does not depend on where scriptc is
 * installed: `scriptc:shims/<path below the shim root>` or
 * `scriptc:<declaration file name>`. Null for every other file. Names and
 * artifacts that would otherwise spell the installation's absolute path use
 * it, so two installations of one compiler emit the same output. */
export function compilerOwnedFileName(file: string): string | null {
  const path = tsgoPath(file);
  for (const { from, to } of compilerOwnedFileRoots()) {
    if (path.startsWith(from)) return to + path.slice(from.length);
  }
  for (const declaration of [ambientDtsPath(), overridesDtsPath(), fallbackDtsPath()]) {
    if (path === declaration) return `scriptc:${path.slice(path.lastIndexOf("/") + 1)}`;
  }
  const modules = fallbackModuleRoot() + "/";
  if (path.startsWith(modules))
    return `scriptc:${FALLBACK_MODULE_DIRECTORY}/${path.slice(modules.length)}`;
  return null;
}

/** Path of the shipped ambient declarations — the always-shipped CORE
 * (comptime, setTimeout). Part of EVERY program scriptc
 * builds, the project-world preflight program included. */
export function ambientDtsPath(): string {
  return declarationPath("scriptc.d.ts");
}

/** Path of the shipped divergence/precision OVERRIDES (JSON.parse():
 * unknown, pop(): T, the Promise executor shape, ...). Part of the LOWERING
 * program only — preflight's project-world second chance builds without it,
 * so a project that typechecks under its own tsc never fails preflight over
 * an override-manufactured error (checkPreflight). */
export function overridesDtsPath(): string {
  return declarationPath("scriptc-overrides.d.ts");
}

/** Path of the shipped FALLBACK declarations (the console and process
 * globals and the modules they name) — part of the program only when the
 * target project has no @types/node. With @types/node, the project's real
 * Node types stand in and this file stands down (its declaration forms
 * would collide). */
export function fallbackDtsPath(): string {
  return declarationPath("scriptc-node-fallback.d.ts");
}

const FALLBACK_MODULE_DIRECTORY = "node-fallback";

/** The fallback declarations of the other Node modules, one file per module
 * under node-fallback/, by specifier (both spellings). Each file references
 * the files of the modules its declarations name. */
const FALLBACK_MODULE_FILES: Readonly<Record<string, string>> = {
  "assert": "assert.d.ts",
  "assert/strict": "assert-strict.d.ts",
  "async_hooks": "async_hooks.d.ts",
  "buffer": "buffer.d.ts",
  "child_process": "child_process.d.ts",
  "cluster": "cluster.d.ts",
  "constants": "constants.d.ts",
  "crypto": "crypto.d.ts",
  "dgram": "dgram.d.ts",
  "diagnostics_channel": "diagnostics_channel.d.ts",
  "dns": "dns.d.ts",
  "dns/promises": "dns-promises.d.ts",
  "events": "events.d.ts",
  "fs": "fs.d.ts",
  "fs/promises": "fs-promises.d.ts",
  "graceful-fs": "graceful-fs.d.ts",
  "http": "http.d.ts",
  "http2": "http2.d.ts",
  "https": "https.d.ts",
  "module": "module.d.ts",
  "net": "net.d.ts",
  "node:assert": "assert.d.ts",
  "node:assert/strict": "assert-strict.d.ts",
  "node:async_hooks": "async_hooks.d.ts",
  "node:buffer": "buffer.d.ts",
  "node:child_process": "child_process.d.ts",
  "node:cluster": "cluster.d.ts",
  "node:constants": "constants.d.ts",
  "node:crypto": "crypto.d.ts",
  "node:dgram": "dgram.d.ts",
  "node:diagnostics_channel": "diagnostics_channel.d.ts",
  "node:dns": "dns.d.ts",
  "node:dns/promises": "dns-promises.d.ts",
  "node:events": "events.d.ts",
  "node:fs": "fs.d.ts",
  "node:fs/promises": "fs-promises.d.ts",
  "node:http": "http.d.ts",
  "node:http2": "http2.d.ts",
  "node:https": "https.d.ts",
  "node:module": "module.d.ts",
  "node:net": "net.d.ts",
  "node:os": "os.d.ts",
  "node:path": "path.d.ts",
  "node:path/posix": "path-posix.d.ts",
  "node:path/win32": "path-win32.d.ts",
  "node:process": "process.d.ts",
  "node:punycode": "punycode.d.ts",
  "node:querystring": "querystring.d.ts",
  "node:stream": "stream.d.ts",
  "node:stream/consumers": "stream-consumers.d.ts",
  "node:stream/promises": "stream-promises.d.ts",
  "node:stream/web": "stream-web.d.ts",
  "node:string_decoder": "string_decoder.d.ts",
  "node:test": "test.d.ts",
  "node:timers": "timers.d.ts",
  "node:timers/promises": "timers-promises.d.ts",
  "node:tls": "tls.d.ts",
  "node:url": "url.d.ts",
  "node:util": "util.d.ts",
  "node:util/types": "util-types.d.ts",
  "node:v8": "v8.d.ts",
  "node:worker_threads": "worker_threads.d.ts",
  "node:zlib": "zlib.d.ts",
  "os": "os.d.ts",
  "path": "path.d.ts",
  "path/posix": "path-posix.d.ts",
  "path/win32": "path-win32.d.ts",
  "process": "process.d.ts",
  "punycode": "punycode.d.ts",
  "querystring": "querystring.d.ts",
  "stream": "stream.d.ts",
  "stream/consumers": "stream-consumers.d.ts",
  "stream/promises": "stream-promises.d.ts",
  "stream/web": "stream-web.d.ts",
  "string_decoder": "string_decoder.d.ts",
  "timers": "timers.d.ts",
  "timers/promises": "timers-promises.d.ts",
  "tls": "tls.d.ts",
  "url": "url.d.ts",
  "util": "util.d.ts",
  "util/types": "util-types.d.ts",
  "v8": "v8.d.ts",
  "worker_threads": "worker_threads.d.ts",
  "zlib": "zlib.d.ts",
};

function fallbackModuleRoot(): string {
  return declarationPath(FALLBACK_MODULE_DIRECTORY);
}

/** The fallback declaration file of the Node module `specifier`, or null. */
export function fallbackModulePath(specifier: string): string | null {
  return Object.hasOwn(FALLBACK_MODULE_FILES, specifier)
    ? declarationPath(`${FALLBACK_MODULE_DIRECTORY}/${FALLBACK_MODULE_FILES[specifier]}`)
    : null;
}

const QUOTED_SPECIFIER = /["'`]((?:node:)?[a-z][a-z0-9_]*(?:[-/][a-z0-9_]+)?)["'`]/g;

/** The fallback declaration files of the Node modules `text` names in a
 * string literal: an over-approximation of the modules its imports, requires,
 * import types and JSDoc types can name. */
export function fallbackModulesNamedIn(text: string): string[] {
  const files = new Set<string>();
  for (const match of text.matchAll(QUOTED_SPECIFIER)) {
    const file = fallbackModulePath(match[1]!);
    if (file !== null) files.add(file);
  }
  return [...files];
}

/** True for the fallback declarations: the core file and the module files. */
export function isFallbackDtsPath(file: string): boolean {
  const path = tsgoPath(file);
  return path === fallbackDtsPath() || path.startsWith(fallbackModuleRoot() + "/");
}

/** True for files belonging to the adopted Node type surface: the
 * @types/node package itself and undici-types (its dependency — the
 * web-platform globals: fetch/Response/AbortSignal/ReadableStream/...).
 * The provenance half of the lowering tables' recognition when the
 * fallback declarations stand down, and of the SC2020-family fence for
 * everything else those packages declare. */
export function isNodeTypesPath(file: string): boolean {
  const pkg = npmPackageNameOf(file);
  return pkg === "@types/node" || pkg === "undici-types";
}
