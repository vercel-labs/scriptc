/* The provenance-sources registry — the flag-gated state `--provenance-
 * sources` compiles against (EXPERIMENTAL prototype).
 *
 * The thesis: an npm package published with provenance attests the exact
 * {repository, commit} its dist was built from, so the compiler can fetch
 * that SOURCE and hand it to the static frontend as ordinary program
 * modules — real TypeScript with real types — instead of island-embedding
 * the published JavaScript. provenance.ts fills this registry before the
 * program loads; the pipeline consults it at three chokepoints:
 *
 *   - resolve.ts resolveProjectImport: a registered bare specifier answers
 *     its mapped source entry (preflight's user-module edges, the module
 *     order, and the CJS link check all ride that one resolver);
 *   - program.ts resolveNpmImport: a registered specifier is NOT an npm
 *     import (no island embed, no .d.ts type surface);
 *   - program.ts loadProgram: the registered entries become tsconfig
 *     "paths" so tsgo's own resolution agrees with ours.
 *
 * Empty registry (the default — the flag off) = every chokepoint answers
 * exactly as before; nothing in the production npm/island path changes. */

export interface ProvenancePackageSource {
  /** Package name ("cookie"). */
  name: string;
  /** The INSTALLED published version the attestation was fetched for. */
  version: string;
  /** The version field of the source tree's package.json, when it
   * disagrees with `version` (release tooling that bumps at publish —
   * babel's shape). Informational; the differential is the real check. */
  sourceVersion?: string;
  /** The attested source repository (https URL). */
  repo: string;
  /** The attested gitCommit digest — the content address of the cached
   * source tree. */
  commit: string;
  /** Absolute path of the package's directory inside the cached source
   * tree (== the tree root except in monorepos). */
  dir: string;
  /** specifier → absolute mapped source file ("cookie" → …/src/index.ts). */
  entries: Record<string, string>;
}

export interface ProvenanceSources {
  /** Successfully source-mapped packages, driver-import order. */
  packages: ProvenancePackageSource[];
  /** Everything that fell back to the island path (or is informational):
   * no attestation, unfetchable source, unmappable entry, version skew.
   * Fallbacks are never build failures — the coverage report carries
   * these so the build output stays honest. */
  notes: string[];
}

interface RegistryState {
  bySpecifier: Map<string, string>;
  packageDirs: string[];
  sources: ProvenanceSources;
}

let state: RegistryState | null = null;

/** Installs the resolved provenance sources for the current compile.
 * Passing null (or an empty set) clears the registry. */
export function setProvenanceSources(sources: ProvenanceSources | null): void {
  if (sources === null || sources.packages.length === 0) {
    state =
      sources === null
        ? null
        : { bySpecifier: new Map(), packageDirs: [], sources };
    return;
  }
  const bySpecifier = new Map<string, string>();
  const packageDirs: string[] = [];
  for (const pkg of sources.packages) {
    packageDirs.push(pkg.dir.endsWith("/") ? pkg.dir : `${pkg.dir}/`);
    for (const [spec, file] of Object.entries(pkg.entries)) {
      bySpecifier.set(spec, file);
    }
  }
  state = { bySpecifier, packageDirs, sources };
}

/** The active sources (for reports), or null when the flag is off. */
export function provenanceSources(): ProvenanceSources | null {
  return state?.sources ?? null;
}

/** The mapped source entry for a bare specifier, or null. */
export function provenanceEntryFor(specifier: string): string | null {
  return state?.bySpecifier.get(specifier) ?? null;
}

/** True when any provenance package is registered. */
export function provenanceActive(): boolean {
  return state !== null && state.bySpecifier.size > 0;
}

/** True when `fileName` lives inside a registered package's source tree —
 * the gate for the third-party-source policies (the pure-annotated
 * dead-const elision, the per-file statement attribution). */
export function isProvenanceSourceFile(fileName: string): boolean {
  if (state === null) return false;
  for (const dir of state.packageDirs) {
    if (fileName.startsWith(dir)) return true;
  }
  return false;
}

/** tsconfig "paths" for the registered entries — loadProgram feeds these
 * to tsgo so the checker resolves registered bare specifiers to the same
 * source files the preflight resolver answers. */
export function provenancePaths(): Record<string, string[]> | null {
  if (state === null || state.bySpecifier.size === 0) return null;
  const paths: Record<string, string[]> = {};
  for (const [spec, file] of state.bySpecifier) paths[spec] = [file];
  return paths;
}
