import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { invalidateTrackedFilesystem } from "./input-tracker.js";
import { sourceImportsOfFile } from "./module-syntax.js";
import type { SourceFile } from "./ts7/ast-types.js";
import type { Ts7SourceKind } from "./ts7/source-parser.js";
import { resolveExports, resolveRelativeModule } from "./resolve.js";
import { packageNameOfSpecifier as packageNameOf } from "./workspace-registry.js";
import type { ProvenancePackageSource, ProvenanceSources } from "./provenance-registry.js";

export type ProvenanceParser = (path: string, source: string, kind: Ts7SourceKind) => SourceFile;

const NODE_IMPORT_CONDITIONS = new Set(["import", "node", "default"]);

const NODE_BUILTINS = new Set(builtinModules);

/** Hard cap on packages one compile will source-map (prototype guard). */
const MAX_PACKAGES = 16;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/* ── the bare-import prescan ─────────────────────────────────────────────
 * The provenance pipeline runs BEFORE the program loads (tsgo needs the
 * "paths" mapping at creation), so the bare specifiers come from a light
 * parse walk of the entry's RELATIVE import closure — the same specifier
 * collection shapes npm.ts scans embedded modules with, over the shared
 * native TypeScript syntax service. */

function moduleSpecifiersLite(
  source: string,
  fileName: string,
  parseSourceFile: ProvenanceParser,
): { spec: string; typeOnly: boolean }[] {
  return sourceImportsOfFile(parseSourceFile(fileName, source, "ts"));
}

/** Every bare (non-relative, non-builtin, non-"#") VALUE specifier the
 * relative closure of `roots` imports, in first-encounter order. */
function bareImportsOf(roots: readonly string[], parseSourceFile: ProvenanceParser): string[] {
  const seenFiles = new Set<string>();
  const bare: string[] = [];
  const bareSeen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = resolve(queue.shift()!);
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const { spec, typeOnly } of moduleSpecifiersLite(text, file, parseSourceFile)) {
      if (typeOnly) continue;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const dep = resolveRelativeModule(file, spec);
        if (dep !== null && !dep.endsWith(".json") && !dep.endsWith(".d.ts")) queue.push(dep);
        continue;
      }
      if (spec.startsWith("#") || spec.startsWith("node:")) continue;
      if (NODE_BUILTINS.has(packageNameOf(spec))) continue;
      if (!bareSeen.has(spec)) {
        bareSeen.add(spec);
        bare.push(spec);
      }
    }
  }
  return bare;
}

/* ── installed-package lookup (name/version/published entry) ──────────── */

interface InstalledPackage {
  dir: string;
  name: string;
  version: string;
  pkgJson: Record<string, unknown>;
}

/** node_modules/<name> walking up from `fromDir`, realpath-free (the
 * published package.json is all this needs). */
function findInstalled(fromDir: string, name: string): InstalledPackage | null {
  for (let dir = fromDir; ;) {
    const candidate = join(dir, "node_modules", name);
    const pkgJson = readJson(join(candidate, "package.json"));
    if (pkgJson !== null && typeof pkgJson["version"] === "string") {
      return {
        dir: candidate,
        name: typeof pkgJson["name"] === "string" ? pkgJson["name"] : name,
        version: pkgJson["version"],
        pkgJson,
      };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/* ── attestation → {repo, commit} ──────────────────────────────────────── */

interface Attested {
  repo: string;
  commit: string;
}

/** GET the npm attestation set and extract the SLSA provenance
 * predicate's resolved source dependency. Throws with a one-line reason
 * on every failure shape (no attestation, network, malformed). */
async function fetchAttestation(name: string, version: string): Promise<Attested> {
  const url = `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(`${name}@${version}`).replace(/%40/g, "@").replace(/%2F/gi, "/")}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) throw new Error("no provenance attestation published");
  if (!res.ok) throw new Error(`attestation fetch failed (HTTP ${res.status})`);
  const body = (await res.json()) as {
    attestations?: { predicateType?: string; bundle?: { dsseEnvelope?: { payload?: string } } }[];
  };
  for (const att of body.attestations ?? []) {
    if (!att.predicateType?.startsWith("https://slsa.dev/provenance")) continue;
    const payload = att.bundle?.dsseEnvelope?.payload;
    if (payload === undefined) continue;
    const stmt = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as {
      predicate?: {
        buildDefinition?: {
          resolvedDependencies?: { uri?: string; digest?: { gitCommit?: string } }[];
        };
      };
    };
    for (const dep of stmt.predicate?.buildDefinition?.resolvedDependencies ?? []) {
      const commit = dep.digest?.gitCommit;
      if (typeof commit === "string" && commit !== "" && typeof dep.uri === "string") {
        return { repo: dep.uri, commit };
      }
    }
  }
  throw new Error("attestation set carries no SLSA provenance predicate");
}

/* ── source fetch (content-addressed by the attested commit) ──────────── */

function cacheRoot(): string {
  return (
    process.env["SCRIPTC_PROVENANCE_CACHE"] ?? join(homedir(), ".cache", "scriptc", "provenance")
  );
}

/** The cached source tree for an attested commit, fetching it once from
 * codeload (github repos only in the prototype). Returns the tree root. */
async function fetchSourceTree(repo: string, commit: string): Promise<string> {
  const dest = join(cacheRoot(), commit);
  if (isDirectory(dest)) return dest;
  const m = /github\.com\/([^/]+)\/([^/@#]+)/.exec(repo);
  if (m === null) throw new Error(`source repository is not a github URL (${repo})`);
  const url = `https://codeload.github.com/${m[1]}/${m[2]}/tar.gz/${commit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`source fetch failed (HTTP ${res.status} for ${url})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  mkdirSync(cacheRoot(), { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "scriptc-provenance-"));
  try {
    const tarball = join(tmp, "src.tgz");
    writeFileSync(tarball, bytes);
    const extractDir = join(tmp, "tree");
    mkdirSync(extractDir);
    execFileSync("tar", ["-xzf", tarball, "-C", extractDir, "--strip-components=1"]);
    try {
      renameSync(extractDir, dest);
    } catch {
      // A parallel compile won the rename — its tree is the same content.
      if (!isDirectory(dest)) throw new Error("source cache rename failed");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  // The tree appeared under this compile: anything it probed as missing
  // before the extraction answers again from disk.
  invalidateTrackedFilesystem();
  return dest;
}

/* ── package dir + source-entry mapping ────────────────────────────────── */

/** The directory inside `tree` whose package.json names `name`: the root,
 * then the conventional monorepo layouts, then a bounded scan. */
function locatePackageDir(tree: string, name: string): string | null {
  const nameOf = (dir: string): string | null => {
    const pkg = readJson(join(dir, "package.json"));
    return pkg !== null && typeof pkg["name"] === "string" ? pkg["name"] : null;
  };
  if (nameOf(tree) === name) return tree;
  const bare = name.startsWith("@") ? name.split("/")[1]! : name;
  const candidates = [
    join(tree, "packages", bare),
    join(tree, "packages", name),
    join(tree, "packages", name.replace("@", "").replace("/", "-")),
    join(tree, "packages", `babel-${bare}`),
  ];
  for (const c of candidates) {
    if (nameOf(c) === name) return c;
  }
  // Bounded breadth-first scan (depth ≤ 3, node_modules/.git skipped).
  const queue: { dir: string; depth: number }[] = [{ dir: tree, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (depth > 0 && nameOf(dir) === name) return dir;
    if (depth >= 3) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir)
        .filter((entry) => isDirectory(join(dir, entry)))
        .sort();
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      queue.push({ dir: join(dir, e), depth: depth + 1 });
    }
  }
  return null;
}

/** The published dist target for `subpath` — "exports" with the import
 * condition, else module/main/types fields (root subpath only). */
function publishedTargetOf(pkgJson: Record<string, unknown>, subpath: string): string | null {
  if (pkgJson["exports"] !== undefined) {
    return resolveExports(pkgJson["exports"], subpath, NODE_IMPORT_CONDITIONS);
  }
  if (subpath !== ".") return subpath;
  for (const field of ["module", "main", "types"]) {
    const v = pkgJson[field];
    if (typeof v === "string" && v !== "") return v;
  }
  return "index.js";
}

/** dist target → source file, heuristically: the built path's leading
 * dist/lib/build segment rewrites to src (or drops), an esm/cjs/dts flavor
 * segment is skipped for a shared TypeScript source tree, extensions
 * rewrite to TypeScript twins, and the root entry falls back to the
 * conventional src/index.ts homes. First existing candidate wins. */
function mapEntryToSource(pkgDir: string, target: string, subpath: string): string | null {
  const rel = target.replace(/^\.\//, "");
  const stems = new Set<string>([rel]);
  const distRe = /^(dist|lib|build|out|output|dist-node|dist-src)\//;
  if (distRe.test(rel)) {
    const withoutDist = rel.replace(distRe, "");
    if (/^(esm|cjs|dts)\//.test(withoutDist)) {
      stems.add(`src/${withoutDist.replace(/^(esm|cjs|dts)\//, "")}`);
    }
    stems.add(rel.replace(distRe, "src/"));
    stems.add(withoutDist);
  } else {
    stems.add(`src/${rel}`);
  }
  const candidates: string[] = [];
  for (const stem of stems) {
    const base = stem.replace(/\.d\.(ts|mts|cts)$/, ".$1").replace(/\.(js|mjs|cjs)$/, "");
    if (/\.(ts|tsx|mts|cts)$/.test(base)) candidates.push(base);
    else {
      candidates.push(`${base}.ts`, `${base}.mts`, `${base}.cts`, `${base}.tsx`);
      candidates.push(join(base, "index.ts"));
    }
  }
  if (subpath === ".") {
    candidates.push("src/index.ts", "src/index.mts", "index.ts", "src/index.tsx");
  }
  for (const c of candidates) {
    const abs = join(pkgDir, c);
    if (isFile(abs)) return abs;
  }
  return null;
}

/* ── the pipeline ─────────────────────────────────────────────────────── */

interface ManifestEntry {
  dir: string;
  commit?: string;
  repo?: string;
}

function readManifest(): Map<string, ManifestEntry> {
  const path = process.env["SCRIPTC_PROVENANCE_MANIFEST"];
  const out = new Map<string, ManifestEntry>();
  if (path === undefined || path === "") return out;
  const manifest = readJson(resolve(path));
  const packages = manifest?.["packages"];
  if (packages === null || typeof packages !== "object") return out;
  for (const [name, raw] of Object.entries(packages as Record<string, unknown>)) {
    if (raw === null || typeof raw !== "object") continue;
    const e = raw as { dir?: unknown; commit?: unknown; repo?: unknown };
    if (typeof e.dir !== "string") continue;
    const dir = isAbsolute(e.dir) ? e.dir : resolve(dirname(resolve(path)), e.dir);
    out.set(name, {
      dir,
      ...(typeof e.commit === "string" ? { commit: e.commit } : {}),
      ...(typeof e.repo === "string" ? { repo: e.repo } : {}),
    });
  }
  return out;
}

export async function resolveProvenanceSourcesWithParser(
  entryPath: string,
  parseSourceFile: ProvenanceParser,
): Promise<ProvenanceSources> {
  const entry = resolve(entryPath);
  const manifest = readManifest();
  const packages: ProvenancePackageSource[] = [];
  const notes: string[] = [];
  /** package name → mapped package (or null after a noted failure). */
  const processed = new Map<string, ProvenancePackageSource | null>();

  /** All specifiers seen so far, grouped by package name. */
  const specifiersByPackage = new Map<string, Set<string>>();
  const enqueue = (specs: readonly string[]): string[] => {
    const newNames: string[] = [];
    for (const spec of specs) {
      const name = packageNameOf(spec);
      let set = specifiersByPackage.get(name);
      if (set === undefined) {
        specifiersByPackage.set(name, (set = new Set()));
        newNames.push(name);
      }
      set.add(spec);
    }
    return newNames;
  };

  const mapOne = async (name: string): Promise<void> => {
    if (processed.has(name)) return;
    if (processed.size >= MAX_PACKAGES) {
      processed.set(name, null);
      notes.push(
        `${name}: skipped — provenance package limit (${MAX_PACKAGES}) reached; published package resolution used`,
      );
      return;
    }
    processed.set(name, null); // claimed; overwritten on success
    const installed = findInstalled(dirname(entry), name);
    if (installed === null) {
      notes.push(
        `${name}: not installed under the entry's node_modules; published package resolution used`,
      );
      return;
    }
    let dir: string;
    let repo: string;
    let commit: string;
    const seeded = manifest.get(name);
    try {
      if (seeded !== undefined) {
        dir = seeded.dir;
        repo = seeded.repo ?? "(manifest)";
        commit = seeded.commit ?? "(manifest)";
        if (!isDirectory(dir)) throw new Error(`manifest dir does not exist (${dir})`);
      } else {
        const attested = await fetchAttestation(installed.name, installed.version);
        repo = attested.repo;
        commit = attested.commit;
        const tree = await fetchSourceTree(repo, commit);
        const located = locatePackageDir(tree, installed.name);
        if (located === null) {
          throw new Error(`package directory not found inside the attested source tree (${tree})`);
        }
        dir = located;
      }
      const entries: Record<string, string> = {};
      for (const spec of specifiersByPackage.get(name) ?? new Set<string>()) {
        const parts = spec.split("/");
        const nameLen = spec.startsWith("@") ? 2 : 1;
        const subpath = parts.length === nameLen ? "." : `./${parts.slice(nameLen).join("/")}`;
        const target = publishedTargetOf(installed.pkgJson, subpath);
        const source = target === null ? null : mapEntryToSource(dir, target, subpath);
        if (source === null) {
          notes.push(
            `${name}@${installed.version}: no source mapping for '${spec}' (published target: ${target ?? "unexported"}); published package resolution used`,
          );
          continue;
        }
        entries[spec] = source;
      }
      if (Object.keys(entries).length === 0) return;
      const srcPkg = readJson(join(dir, "package.json"));
      const sourceVersion = typeof srcPkg?.["version"] === "string" ? srcPkg["version"] : undefined;
      const pkg: ProvenancePackageSource = {
        name: installed.name,
        version: installed.version,
        ...(sourceVersion !== undefined && sourceVersion !== installed.version
          ? { sourceVersion }
          : {}),
        repo,
        commit,
        dir,
        entries,
      };
      if (pkg.sourceVersion !== undefined) {
        notes.push(
          `${name}: source tree's package.json says ${pkg.sourceVersion}, installed is ${installed.version} (release tooling that bumps at publish) — the behavior differential is the check`,
        );
      }
      packages.push(pkg);
      processed.set(name, pkg);
      // One transitive round: the mapped source's own bare imports try
      // the pipeline too (versions resolve from the DRIVER's tree — a
      // prototype heuristic; production wants the package's lockfile).
      const inner = enqueue(bareImportsOf(Object.values(entries), parseSourceFile));
      for (const n of inner) await mapOne(n);
    } catch (e) {
      notes.push(
        `${name}@${installed.version}: ${e instanceof Error ? e.message : String(e)}; published package resolution used`,
      );
    }
  };

  for (const name of enqueue(bareImportsOf([entry], parseSourceFile))) {
    await mapOne(name);
  }
  return { packages, notes };
}
