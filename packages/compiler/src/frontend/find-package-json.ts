/* module.findPackageJSON resolved at build time.
 *
 * Node's lib/internal/modules/package_json_reader.js answers the nearest
 * package.json for a specifier: a bare specifier resolves to its package's
 * root package.json (a self-reference through the base's own package, then a
 * node_modules walk), and a relative or absolute specifier first goes through
 * the default ES module resolver (the target must exist; a directory is
 * accepted) and then walks up to the nearest package.json, answering the
 * resolved path itself when there is none.
 *
 * The answer is a build-time fact about the source tree, so every filesystem
 * question goes through the tracked input helpers: a change to a package.json
 * or to a package directory rebuilds the program. The paths are the host's;
 * a build whose target uses other path rules refuses instead of guessing.
 */
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  trackedDirectoryExists,
  trackedFileExists,
  trackedReadFile,
  trackedRealpath,
} from "./input-tracker.js";

export type FindPackageJsonResult = { ok: true; path: string } | { ok: false; refusal: string };

interface PackageScope {
  path: string;
  name: string | null;
  hasExports: boolean;
}

type PackageScopeResult = { ok: true; scope: PackageScope | null } | { ok: false; refusal: string };

/* Node's parsePackageName: a package name cannot start with `.`, and cannot
 * contain a percent sign or a backslash. */
const INVALID_PACKAGE_NAME = /^\.|%|\\/;

function invalidPackageName(specifier: string): FindPackageJsonResult {
  return {
    ok: false,
    refusal: `Invalid module "${specifier}" is not a valid package name`,
  };
}

function packageNameOf(specifier: string): { name: string } | FindPackageJsonResult {
  let separatorIndex = specifier.indexOf("/");
  if (specifier.startsWith("@")) {
    if (separatorIndex === -1 || specifier.length === 0) return invalidPackageName(specifier);
    separatorIndex = specifier.indexOf("/", separatorIndex + 1);
  }
  const name = separatorIndex === -1 ? specifier : specifier.slice(0, separatorIndex);
  if (name.length === 0 || INVALID_PACKAGE_NAME.test(name)) return invalidPackageName(specifier);
  return { name };
}

/** The nearest package.json at or above `path` (for a file, from its
 * directory), as Node reads it: the walk stops at a node_modules directory,
 * a document that is not a JSON object is Node's ERR_INVALID_PACKAGE_CONFIG,
 * and `hasExports` records an "exports" field that is neither absent nor
 * null (Node's `exports != null` self-reference test). */
function packageScopeOf(path: string): PackageScopeResult {
  /* Node starts at the path itself only when the resolved URL ends with a
   * separator, and at its parent otherwise: `./nested/` walks from the
   * directory, while `./nested` and `../bar` walk from the parent even when
   * they name a directory. */
  let dir = path.endsWith(sep) ? path : dirname(path);
  for (;;) {
    if (basename(dir) === "node_modules") return { ok: true, scope: null };
    const candidate = join(dir, "package.json");
    if (trackedFileExists(candidate)) {
      const text = trackedReadFile(candidate);
      let parsed: unknown = null;
      let valid = false;
      if (text !== null) {
        try {
          parsed = JSON.parse(text);
          valid = parsed !== null && typeof parsed === "object";
        } catch {
          valid = false;
        }
      }
      if (!valid) return { ok: false, refusal: `Invalid package config ${candidate}.` };
      const record = parsed as { name?: unknown; exports?: unknown };
      return {
        ok: true,
        scope: {
          path: candidate,
          name: typeof record.name === "string" ? record.name : null,
          hasExports: record.exports !== undefined && record.exports !== null,
        },
      };
    }
    const parent = dirname(dir);
    if (parent === dir) return { ok: true, scope: null };
    dir = parent;
  }
}

/** A bare specifier: its package's root package.json, through a
 * self-reference or the node_modules chain above the base. Node walks the
 * base URL as given (no symlink resolution). */
function barePackageJson(specifier: string, baseHref: string): FindPackageJsonResult {
  const named = packageNameOf(specifier);
  if (!("name" in named)) return named;
  let basePath: string;
  try {
    basePath = fileURLToPath(new URL(baseHref));
  } catch {
    return { ok: false, refusal: "the base must be a file: URL to resolve a package name" };
  }
  const scope = packageScopeOf(basePath);
  if (!scope.ok) return { ok: false, refusal: scope.refusal };
  if (scope.scope !== null && scope.scope.hasExports && scope.scope.name === named.name)
    return { ok: true, path: scope.scope.path };
  const scoped = specifier.startsWith("@");
  let url = new URL(`./node_modules/${named.name}/package.json`, baseHref);
  let previous = "";
  for (;;) {
    const file = fileURLToPath(url);
    const suffix = `${sep}package.json`;
    const dir = file.endsWith(suffix) ? file.slice(0, -suffix.length) : file.slice(0, -9);
    if (trackedDirectoryExists(dir)) return { ok: true, path: file };
    previous = url.pathname;
    url = new URL(`${scoped ? "../" : ""}../../../node_modules/${named.name}/package.json`, url);
    /* Node's loop ends when the path stops shrinking (it reached the root). */
    if (url.pathname.length === previous.length) break;
  }
  return { ok: false, refusal: `Cannot find package '${named.name}'` };
}

/** A relative or absolute specifier through the default ES module resolver:
 * URL resolution against the base, a file: scheme, an existing file (symlinks
 * resolved) or directory, then the nearest package.json. */
function resolvedPackageJson(specifier: string, baseHref: string): FindPackageJsonResult {
  let url: URL;
  try {
    url = new URL(specifier, baseHref);
  } catch {
    return { ok: false, refusal: `Invalid URL: ${specifier} (a relative base must be a URL)` };
  }
  if (url.protocol !== "file:")
    return { ok: false, refusal: `The URL must be of scheme file, got "${url.protocol}"` };
  let path: string;
  try {
    path = fileURLToPath(url);
  } catch {
    return { ok: false, refusal: `Invalid file: URL: ${specifier}` };
  }
  if (trackedFileExists(path)) {
    const real = trackedRealpath(path) ?? path;
    const scope = packageScopeOf(real);
    if (!scope.ok) return { ok: false, refusal: scope.refusal };
    return { ok: true, path: scope.scope?.path ?? real };
  }
  if (trackedDirectoryExists(path)) {
    const scope = packageScopeOf(path);
    if (!scope.ok) return { ok: false, refusal: scope.refusal };
    return { ok: true, path: scope.scope?.path ?? path };
  }
  return { ok: false, refusal: `Cannot find module '${path}'` };
}

/** Whether the host's path rules can answer a findPackageJSON for `target`. */
export function findPackageJsonPathsMatchHost(target: string): boolean {
  return process.platform !== "win32" && target !== "win32" && target !== "wasi";
}

/** module.findPackageJSON(specifier, base) at build time. `baseHref` is the
 * base as a URL (a path base is converted with pathToFileURL first). */
export function findPackageJson(specifier: string, baseHref: string): FindPackageJsonResult {
  const bare =
    specifier.length > 0 &&
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !URL.canParse(specifier);
  return bare ? barePackageJson(specifier, baseHref) : resolvedPackageJson(specifier, baseHref);
}

/** The file: URL a base expression names, or null when the spelling is not
 * static. */
export function baseHrefOfPath(path: string): string {
  return pathToFileURL(path).href;
}

/** Whether `value` can be read as an absolute filesystem path or a file:
 * URL base (Node refuses a relative path base with ERR_INVALID_URL). */
export function baseUrlLiteral(value: string): string | null {
  if (URL.canParse(value)) return value;
  return isAbsolute(value) ? pathToFileURL(value).href : null;
}
