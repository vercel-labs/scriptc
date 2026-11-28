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

import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { packageDirOf, packageVersionOf } from "../node-islands/origin.js";

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
 * name — the scope's OWN directory and its manifest — or null when none
 * above it has one. The directory is the part that must be cached: every
 * directory below a scope answers the same scope root, so caching only the
 * manifest made the next walk treat the directory it started from as the
 * package root. Absence from the map is the visit mark. */
export type PackageScopeCache = Map<string, { dir: string; manifest: ManifestName } | null>;

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
    if (known !== undefined) return propagate(chain, cache, known);
    const manifest = manifestAt(current);
    chain.push(current);
    if (manifest !== null && manifest.name !== null) {
      const answer = { dir: current, manifest };
      cache.set(current, answer);
      return propagate(chain, cache, answer);
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
  for (const dir of chain) cache.set(dir, answer);
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
