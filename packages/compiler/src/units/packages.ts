/* Which package a program file belongs to, for the unit graph.
 *
 * A file's unit is the nearest enclosing package.json that has a `name`.
 * Installed files answer through the frontend's own package attribution
 * (`packageDirOf` / `packageVersionOf`, node-islands/origin.ts) instead of a
 * directory walk; project files (the app and workspace members) walk up to
 * their package scope once per directory, which is the rule the frontend's
 * resolver uses for package.json lookups.
 *
 * The package root's realpath is part of the answer only to tell two copies
 * of one version apart. */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { packageDirOf, packageVersionOf } from "../node-islands/origin.js";
import type { UnitPackageFile } from "./types.js";

/** One file's package attribution. */
export interface FilePackage {
  name: string | null;
  version: string | null;
  root: string | null;
}

/** A manifest as far as unit attribution reads it. */
export interface ManifestName {
  name: string | null;
  version: string | null;
}

/** The directory walk's cache: a directory's nearest package scope with a
 * name, or null when none above it has one. `undefined` marks an
 * unvisited directory (a Map cannot hold it, so absence is the visit
 * mark). */
export type PackageScopeCache = Map<string, ManifestName | null>;

function forwardSlashes(path: string): string {
  return path.split("\\").join("/");
}

/** The manifest at `dir`, or its absence: an unreadable or malformed
 * package.json has no name. */
function manifestAt(dir: string): ManifestName | null {
  let text: string;
  try {
    text = readFileSync(resolve(dir, "package.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const name = typeof record["name"] === "string" && record["name"] !== "" ? record["name"] : null;
  const version = typeof record["version"] === "string" ? record["version"] : null;
  return { name, version };
}

/** The nearest package scope at or above `dir` whose package.json has a
 * name, or null. */
export function nearestNamedScope(
  dir: string,
  cache: PackageScopeCache = new Map(),
): { dir: string; manifest: ManifestName } | null {
  const chain: string[] = [];
  let current = resolve(dir);
  for (;;) {
    const known = cache.get(current);
    if (known !== undefined) {
      if (known === null || known.name === null) return propagate(chain, cache, null);
      return propagate(chain, cache, { dir: current, manifest: known });
    }
    const manifest = manifestAt(current);
    chain.push(current);
    if (manifest !== null && manifest.name !== null) {
      cache.set(current, manifest);
      return propagate(chain, cache, { dir: current, manifest });
    }
    const parent = dirname(current);
    if (parent === current) return propagate(chain, cache, null);
    current = parent;
  }
}

/** Records a walk's answer for every directory it visited: a directory
 * below a scope resolves to that scope, and one below none to null. */
function propagate(
  chain: readonly string[],
  cache: PackageScopeCache,
  answer: { dir: string; manifest: ManifestName } | null,
): { dir: string; manifest: ManifestName } | null {
  for (const dir of chain) cache.set(dir, answer === null ? null : answer.manifest);
  return answer;
}

/** The realpath of `dir`, forward-slash, or the resolved path itself when it
 * cannot be resolved (a deleted directory, an unreadable mount). */
export function realpathOf(dir: string): string {
  try {
    return forwardSlashes(realpathSync(dir));
  } catch {
    return forwardSlashes(resolve(dir));
  }
}

/** The package a program file belongs to, or null when no package.json above
 * it has a name (the file then joins the app unit). */
export function packageOfFile(
  file: string,
  appRoot: string,
  cache: PackageScopeCache = new Map(),
): FilePackage & { relative: string } {
  const path = forwardSlashes(file);
  // An installed file: the frontend's own attribution names the innermost
  // node_modules package without walking.
  const installed = packageDirOf(path);
  if (installed !== null) {
    const root = realpathOf(installed.dir);
    return {
      name: installed.name,
      version: packageVersionOf(installed.dir),
      root,
      relative: relativeTo(root, path),
    };
  }
  const scope = nearestNamedScope(dirname(path), cache);
  if (scope === null) {
    return {
      name: null,
      version: null,
      root: null,
      relative: relativeTo(appRoot, path),
    };
  }
  const root = realpathOf(scope.dir);
  return {
    name: scope.manifest.name,
    version: scope.manifest.version,
    root,
    relative: relativeTo(root, path),
  };
}

/** `file`'s path under `root`, forward slashes. A file outside the root
 * keeps a `../` prefix rather than an absolute path: the key may not carry
 * one. */
function relativeTo(root: string, file: string): string {
  const rel = forwardSlashes(relative(root, file));
  return rel === "" ? basename(file) : rel;
}

/** The extensions the frontend loads as implementation source. */
const IMPLEMENTATION_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/** Every implementation source file under an installed package root, with
 * its content digest, sorted by package-relative path.
 *
 * A unit's file set is its package as installed, not the files this build
 * reached: an app that stops reaching one file of a package must not change
 * that package's key. Declaration files (`*.d.ts`) are left out (they carry
 * no implementation and the frontend excludes them from the lowering), and
 * so are nested `node_modules` directories (each package there is its own
 * unit) and dot-directories. A file that cannot be read is left out too: it
 * cannot affect a lowering that could not have loaded it. */
export function packageDirectorySources(root: string): UnitPackageFile[] {
  const out: UnitPackageFile[] = [];
  const seen = new Set<string>();
  const walk = (dir: string): void => {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      const path = join(dir, name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stat = statSync(path);
          isDirectory = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
      }
      if (isDirectory) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        walk(path);
        continue;
      }
      if (!isFile) continue;
      if (name.endsWith(".d.ts") || IMPLEMENTATION_EXTENSIONS.has(extname(name)) === false)
        continue;
      let contents: Buffer;
      try {
        contents = readFileSync(path);
      } catch {
        continue;
      }
      out.push({ relative: relativeTo(root, path), digest: digestOfFile(contents) });
    }
  };
  walk(root);
  return out.sort((a, b) => a.relative.localeCompare(b.relative));
}

/** sha256 of a file's bytes, hex. */
function digestOfFile(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}
