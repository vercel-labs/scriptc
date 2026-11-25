/* The build and staging scripts whose contents decide a bootstrap seed's executable outputs.
 *
 * A seed records the SHA-256 of every file in this import graph, and every consumer recomputes the graph from its
 * own checkout before using the seed. A seed built with different staging code is therefore rejected instead of
 * run. The list comes from the entry points' imports, not a hand-maintained list, so a newly imported helper is
 * part of the identity without anyone remembering to add it.
 *
 * Imports that leave `scripts/` and `native/` (the compiler packages, Node builtins and dependencies) are covered
 * by the seed task's other inputs, so the recorded set stays to the build and staging code.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** The entry points whose code produces or stages a seed's executable outputs. */
export const seedEntryPoints = ["scripts/bootstrap-seed.mjs", "scripts/build-native-cli.mts"];

// `import ... from "..."`, `export ... from "..."`, side-effect `import "..."`, and `import("...")`.
const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

function resolveRelative(fromFile, path) {
  if (!path.startsWith(".")) return undefined;
  const base = resolve(dirname(fromFile), path);
  const candidates = [base];
  // TypeScript sources are imported by their emitted `.js` or `.mjs` name.
  if (/\.(mjs|js)$/.test(base))
    candidates.push(base.replace(/\.(mjs|js)$/, ".mts"), base.replace(/\.(mjs|js)$/, ".ts"));
  candidates.push(`${base}.ts`, `${base}.mts`, `${base}.mjs`, `${base}.js`);
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/** The repository-relative files in the seed build's import graph, sorted. */
export function seedInputFiles(repoRoot = root, entries = seedEntryPoints) {
  const files = new Set();
  const pending = entries.map((entry) => join(repoRoot, entry));
  while (pending.length > 0) {
    const file = pending.pop();
    const path = relative(repoRoot, file).split(sep).join("/");
    if (files.has(path)) continue;
    files.add(path);
    for (const match of readFileSync(file, "utf8").matchAll(specifier)) {
      const resolved = resolveRelative(file, match[1]);
      if (resolved === undefined) continue;
      const resolvedPath = relative(repoRoot, resolved).split(sep).join("/");
      if (resolvedPath.startsWith("scripts/") || resolvedPath.startsWith("native/"))
        pending.push(resolved);
    }
  }
  return [...files].sort();
}

/** The seed-relevant files and their SHA-256 digests, keyed by repository-relative path. */
export function seedInputHashes(repoRoot = root, entries = seedEntryPoints) {
  return Object.fromEntries(
    seedInputFiles(repoRoot, entries).map((path) => [
      path,
      createHash("sha256")
        .update(readFileSync(join(repoRoot, path)))
        .digest("hex"),
    ]),
  );
}
