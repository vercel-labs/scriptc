/* Type patches: project-owned fixes for wrong npm declarations.
 *
 * `scriptc.typePatches` in the entry's package.json maps
 * `"<package>@<range>"` to declaration patches (project-config.ts):
 *
 *   "commander@^15.0.0": { "declarations": { "HelpContext.helpWidth": "| undefined" } }
 *
 * The patches are applied to file TEXT, in one place every consumer reads
 * through: the program host's source reads (ts7/program-host.ts), which
 * serve both checker worlds (the lowering world that types package
 * JavaScript from its JSDoc, and the declaration world that types user
 * code at the declaration boundary), and the npm-static passes that read
 * package files themselves (`packageSourceText`). Downstream, the patched
 * declaration simply IS the declaration: scriptc enforces it exactly as it
 * enforced the original, so a patch can never make a check weaker than the
 * declaration it replaces.
 *
 * A patch applies to an installed copy whose version satisfies its range;
 * an `@types/<name>` twin is matched by the runtime package's name and
 * installed version. Without patches nothing here runs: `typePatchedText`
 * answers undefined from one null test, so every program reads the same
 * bytes as before (the zero-cost rule).
 *
 * See scriptc-perf/results/design-type-patches/DESIGN.md. */

import { dirname, relative } from "node:path";
import type { ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import { typePatchDiag } from "../../diagnostics/diagnostic.js";
import { readProjectConfig, type TypePatchEntry } from "../../project-config.js";
import { trackedFileExists, trackedReadFile } from "../input-tracker.js";
import type { SourceFile } from "../ts7/syntax.js";
import { applyPatchEdits, patchFile, type PatchMatch, type PatchRequest } from "./locate.js";
import { parseSelector, parseTypeText, type Selector, type TypePatchOp } from "./selector.js";
import { satisfies } from "./semver.js";

export type TypePatchParse = (path: string, text: string, kind: "ts" | "js") => SourceFile;

interface Request extends PatchRequest {
  entry: TypePatchEntry;
  /** Offset of the selector in the manifest. */
  offset: number;
}

interface CopyInfo {
  /** The runtime package's name (for an `@types` twin, the package it
   * types). */
  pkg: string;
  version: string | null;
  root: string;
  /** Requests whose entry's range the version satisfies. */
  requests: Request[];
  /** Replaced declaration files: package-relative path → local file. */
  files: Map<string, string>;
  /** Declaration entries a `types` patch supplies: package-relative path
   * → local file (existing entries are replaced, missing ones appear). */
  entries: Map<string, string>;
}

interface MatchRecord extends PatchMatch {
  file: string;
  pkg: string;
  version: string | null;
}

interface State {
  manifest: string;
  /** The directory of the project's package.json. */
  projectDir: string;
  manifestText: string;
  parse: TypePatchParse;
  byPackage: Map<string, { entries: TypePatchEntry[]; requests: Request[] }>;
  copies: Map<string, CopyInfo | null>;
  files: Map<string, string | null>;
  /** `files` targets that do not exist in a copy. */
  missingFiles: { entry: TypePatchEntry; root: string; rel: string }[];
  /** Package copies whose version no patch range covers. */
  unmatchedCopies: Map<string, { pkg: string; version: string | null; entries: TypePatchEntry[] }>;
  /** Requests applicable to a copy this load read files of. */
  touched: Set<Request>;
  matches: MatchRecord[];
  problems: Map<Request, { message: string; always: boolean }>;
  /** Patched spans per served file (patched-text coordinates). */
  spans: Map<string, { start: number; end: number }[]>;
}

let state: State | null = null;

/** Registers the project's type patches for one program load (or clears
 * them). Called once per load, like configurePackageShims. */
export function configureTypePatches(entryPath: string, parse: TypePatchParse): void {
  const config = readProjectConfig(entryPath);
  if (config.typePatches.length === 0 || config.manifest === null) {
    state = null;
    return;
  }
  const byPackage = new Map<string, { entries: TypePatchEntry[]; requests: Request[] }>();
  let id = 0;
  for (const entry of config.typePatches) {
    const pkg = byPackage.get(entry.pkg) ?? { entries: [], requests: [] };
    byPackage.set(entry.pkg, pkg);
    pkg.entries.push(entry);
    for (const decl of entry.declarations) {
      const selector = parseSelector(decl.selector);
      const op = parseTypeText(decl.type);
      if ("error" in selector || "error" in op) continue; // reported as SC8004
      pkg.requests.push({
        id: id++,
        selector: selector as Selector,
        op: op as TypePatchOp,
        entry,
        offset: decl.offset,
      });
    }
  }
  state = {
    manifest: config.manifest,
    projectDir: dirname(config.manifest),
    manifestText: config.manifestText ?? "",
    parse,
    byPackage,
    copies: new Map(),
    files: new Map(),
    missingFiles: [],
    unmatchedCopies: new Map(),
    touched: new Set(),
    matches: [],
    problems: new Map(),
    spans: new Map(),
  };
}

/** True while the current load has type patches. */
export function typePatchesActive(): boolean {
  return state !== null;
}

const PATCHABLE = /\.(?:[cm]?js|d\.[cm]?ts|[cm]?ts)$/;

/** `@types/foo__bar` types `@foo/bar`. */
function unmangleTypesName(name: string): string {
  const bare = name.slice("@types/".length);
  const i = bare.indexOf("__");
  return i > 0 ? `@${bare.slice(0, i)}/${bare.slice(i + 2)}` : bare;
}

function versionAt(dir: string): string | null {
  const text = trackedReadFile(`${dir}/package.json`);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/** The version of the runtime package `pkg` an `@types` twin under
 * `nodeModules` describes: the copy installed beside it, else the one the
 * project resolves (pnpm keeps each package in its own directory, so a
 * twin has no runtime package beside it), else null. */
function twinRuntimeVersion(s: State, nodeModules: string, pkg: string): string | null {
  const beside = versionAt(nodeModules + pkg);
  if (beside !== null) return beside;
  for (let dir = s.projectDir; ;) {
    const version = versionAt(`${dir}/node_modules/${pkg}`);
    if (version !== null) return version;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The installed package copy a file belongs to, with the requests that
 * apply to it; null for files outside node_modules or of unpatched
 * packages. */
function copyOf(s: State, path: string, touch = true): { copy: CopyInfo; rel: string } | null {
  const marker = "/node_modules/";
  const at = path.lastIndexOf(marker);
  if (at < 0) return null;
  const after = path.slice(at + marker.length);
  const parts = after.split("/");
  const nameParts = parts[0]!.startsWith("@") ? 2 : 1;
  if (parts.length <= nameParts) return null;
  const name = parts.slice(0, nameParts).join("/");
  const root = path.slice(0, at + marker.length) + name;
  const rel = parts.slice(nameParts).join("/");
  let copy = s.copies.get(root);
  if (copy === undefined) {
    copy = null;
    const twin = name.startsWith("@types/");
    const pkg = twin ? unmangleTypesName(name) : name;
    const patches = s.byPackage.get(pkg);
    if (patches !== undefined) {
      // A twin is matched by the runtime package's version, never its own.
      const version = twin
        ? twinRuntimeVersion(s, path.slice(0, at + marker.length), pkg)
        : versionAt(root);
      const applicable = patches.entries.filter(
        (e) => version !== null && satisfies(version, e.range),
      );
      if (applicable.length === 0) {
        s.unmatchedCopies.set(root, { pkg, version, entries: patches.entries });
      } else {
        // Later entries win on the same selector, file or entry.
        const bySelector = new Map<string, Request>();
        for (const r of patches.requests)
          if (applicable.includes(r.entry)) bySelector.set(r.selector.text, r);
        const files = new Map<string, string>();
        let types: string | null = null;
        const prefix = `${name}/`;
        for (const e of applicable) {
          for (const [target, local] of e.files) {
            // `@types/<name>/<path>` names the twin's file; plain paths the
            // package's own.
            const forTwin = target.startsWith("@types/");
            if (forTwin !== twin) continue;
            const rel = forTwin
              ? target.startsWith(prefix)
                ? target.slice(prefix.length)
                : null
              : target;
            if (rel === null) continue;
            if (!trackedFileExists(`${root}/${rel}`)) {
              s.missingFiles.push({ entry: e, root, rel });
              continue;
            }
            files.set(rel, local);
          }
          if (e.types !== null && !twin) types = e.types;
        }
        copy = {
          pkg,
          version,
          root,
          requests: [...bySelector.values()],
          files,
          entries: types === null ? new Map() : declarationEntries(root, types),
        };
      }
    }
    s.copies.set(root, copy);
  }
  if (copy === null) return null;
  if (touch) for (const r of copy.requests) s.touched.add(r);
  return { copy, rel };
}

/** The declaration entry paths of a package a `types` patch stands for:
 * its `types`/`typings` file and every declaration TypeScript probes
 * beside a JavaScript entry (`main`, the `exports` targets of "."). */
function declarationEntries(root: string, local: string): Map<string, string> {
  const out = new Map<string, string>();
  let pkg: Record<string, unknown> = {};
  try {
    pkg = JSON.parse(trackedReadFile(`${root}/package.json`) ?? "{}") as Record<string, unknown>;
  } catch {
    pkg = {};
  }
  const add = (target: unknown): void => {
    if (typeof target !== "string") return;
    const rel = target.replace(/^\.\//, "");
    if (/\.d\.[cm]?ts$/.test(rel)) out.set(rel, local);
    else if (/\.[cm]?js$/.test(rel)) out.set(rel.replace(/\.([cm]?)js$/, ".d.$1ts"), local);
    // TypeScript probes x.tsx and then x.d.ts for x.jsx.
    else if (rel.endsWith(".jsx")) out.set(`${rel.slice(0, -".jsx".length)}.d.ts`, local);
    else if (!/\.\w+$/.test(rel)) out.set(`${rel}.d.ts`, local);
  };
  add(pkg["types"]);
  add(pkg["typings"]);
  add(typeof pkg["main"] === "string" ? pkg["main"] : "index.js");
  const exportsField = pkg["exports"];
  const dot =
    exportsField !== null && typeof exportsField === "object" && "." in exportsField
      ? (exportsField as Record<string, unknown>)["."]
      : exportsField;
  const visit = (v: unknown): void => {
    if (typeof v === "string") add(v);
    else if (v !== null && typeof v === "object") for (const x of Object.values(v)) visit(x);
  };
  // Subpath exports ("./x") are not the entry.
  if (dot !== null && typeof dot === "object" && Object.keys(dot).some((k) => k.startsWith(".")))
    return out;
  visit(dot);
  return out;
}

/** True for a declaration entry a `types` patch supplies that does not
 * exist on disk (a package without declarations gains one). */
export function typePatchFileExists(fileName: string): boolean {
  const s = state;
  if (s === null) return false;
  const path = fileName.split("\\").join("/");
  if (!/\.d\.[cm]?ts$/.test(path)) return false;
  const located = copyOf(s, path, false);
  return located !== null && located.copy.entries.has(located.rel);
}

/** True when a `types` patch gives the package at `pkgDir` declarations. */
export function typePatchSuppliesTypes(pkgDir: string): boolean {
  const s = state;
  if (s === null) return false;
  const located = copyOf(s, `${pkgDir.split("\\").join("/")}/package.json`, false);
  return located !== null && located.copy.entries.size > 0;
}

/** Names a request's root can appear under in a file's text. */
function rootWords(sel: Selector): string[] {
  if (sel.root === "export=") return ["exports", "export"];
  if (sel.root === "default") return ["default"];
  return [sel.root];
}

/** The patched text of a package file, or undefined when no patch applies
 * to it (callers then read the file as usual). */
export function typePatchedText(fileName: string): string | undefined {
  const s = state;
  if (s === null) return undefined;
  const path = fileName.split("\\").join("/");
  if (!PATCHABLE.test(path)) return undefined;
  const cached = s.files.get(path);
  if (cached !== undefined) return cached ?? undefined;
  let result: string | null = null;
  const located = copyOf(s, path);
  if (located !== null) {
    // A replaced file or a supplied entry reads as the local file; the
    // declaration patches then apply to it like to the package's own.
    const local = located.copy.files.get(located.rel) ?? located.copy.entries.get(located.rel);
    const replaced = local === undefined ? null : trackedReadFile(local);
    const text = replaced ?? trackedReadFile(path);
    if (replaced !== null) result = replaced;
    const requests = located.copy.requests.filter(
      (r) =>
        (r.selector.file === null || r.selector.file === located.rel) &&
        rootWords(r.selector).some((w) => text?.includes(w)),
    );
    if (text !== null && requests.length > 0) {
      const kind = /\.[cm]?ts$/.test(path) ? "ts" : "js";
      let out: ReturnType<typeof patchFile> | null = null;
      try {
        out = patchFile(located.rel, text, s.parse(path, text, kind), requests);
      } catch {
        out = null; // unparseable: served unpatched, like other npm-static passes
      }
      if (out !== null) {
        const byId = new Map(requests.map((r) => [r.id, r]));
        for (const m of out.matches) {
          s.matches.push({
            ...m,
            file: path,
            pkg: located.copy.pkg,
            version: located.copy.version,
          });
        }
        for (const p of out.problems) {
          const r = byId.get(p.id);
          const prior = r === undefined ? undefined : s.problems.get(r);
          if (r !== undefined && (prior === undefined || (p.always === true && !prior.always)))
            s.problems.set(r, {
              message: `${p.message} (${located.rel})`,
              always: p.always === true,
            });
        }
        if (out.edits.length > 0) {
          result = applyPatchEdits(text, out.edits);
          s.spans.set(path, patchedSpans(out.edits));
        }
      }
    }
  }
  s.files.set(path, result);
  return result ?? undefined;
}

/** Edit spans in the patched text's coordinates. */
function patchedSpans(
  edits: readonly { start: number; end: number; text: string }[],
): { start: number; end: number }[] {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: { start: number; end: number }[] = [];
  let shift = 0;
  for (const e of sorted) {
    const start = e.start + shift;
    out.push({ start, end: start + e.text.length });
    shift += e.text.length - (e.end - e.start);
  }
  return out;
}

/** Text a package file is read as by passes that read package files
 * themselves (npm-static): the patched text, or the file. */
export function packageSourceText(path: string): string | null {
  return typePatchedText(path) ?? trackedReadFile(path);
}

/** The spans a type patch edited in a served file (patched-text offsets),
 * for passes that rewrite package JSDoc and must keep patched comments
 * (the shape overlay). Empty when nothing was patched. */
export function typePatchedSpans(fileName: string): readonly { start: number; end: number }[] {
  return state?.spans.get(fileName.split("\\").join("/")) ?? [];
}

/** Every applied match of the current load (for `scriptc types patch
 * --list` and tests). */
export function typePatchMatches(): readonly MatchRecord[] {
  return state?.matches ?? [];
}

function loc(s: State, offset: number): { file: string; start: number; end: number } {
  return { file: s.manifest, start: offset, end: offset };
}

/** The current load's type patch warnings: SC8030 (no range covers an
 * installed copy), SC8031 (a selector matched nothing), SC8032 (redundant:
 * the declaration already has the type), SC8033 (ambiguous or not
 * patchable as written). Only packages the program loads are reported. */
export function typePatchDiagnostics(): {
  diagnostics: ScrDiagnostic[];
  manifest: string;
  manifestText: string;
} | null {
  const s = state;
  if (s === null) return null;
  const out: ScrDiagnostic[] = [];
  for (const [root, info] of s.unmatchedCopies) {
    const shown = info.version ?? "an unknown version";
    for (const entry of info.entries) {
      out.push(
        typePatchDiag(
          "SC8030",
          `type patch '${entry.key}' does not apply to ${info.pkg} ${shown} at ${relativeToManifest(s, root)}; its declarations are used unpatched`,
          info.version === null
            ? "the installed package has no version"
            : `check whether the declarations of ${info.pkg} ${info.version} still need the patch, then widen the range or remove it`,
          loc(s, entry.offset),
        ),
      );
    }
  }
  for (const missing of s.missingFiles) {
    out.push(
      typePatchDiag(
        "SC8031",
        `type patch '${missing.entry.key}': ${missing.rel} is not a file of ${missing.entry.pkg} at ${relativeToManifest(s, missing.root)}`,
        "name a declaration file the installed package ships; the package may have moved it",
        loc(s, missing.entry.offset),
      ),
    );
  }
  for (const r of s.touched) {
    const mine = s.matches.filter((m) => m.id === r.id);
    // A selector that matched somewhere (the .d.ts) is not a problem where
    // it cannot apply (undocumented JavaScript), unless a declaration it
    // names was left unpatched.
    const problem = s.problems.get(r);
    if (problem !== undefined && (mine.length === 0 || problem.always)) {
      out.push(
        typePatchDiag(
          "SC8033",
          `type patch '${r.entry.key}': ${problem.message}`,
          "name one declaration, or patch the declared type it refers to",
          loc(s, r.offset),
        ),
      );
      continue;
    }
    if (mine.length === 0) {
      out.push(
        typePatchDiag(
          "SC8031",
          `type patch '${r.entry.key}': '${r.selector.text}' matches no declaration in the files of ${r.entry.pkg} this program loads`,
          "check the spelling against the package's declarations and JSDoc; the package may have renamed it",
          loc(s, r.offset),
        ),
      );
      continue;
    }
    if (mine.every((m) => m.redundant))
      out.push(
        typePatchDiag(
          "SC8032",
          `type patch '${r.entry.key}': '${r.selector.text}' is already declared as ${mine[0]!.before}`,
          "the package's declarations already say this; remove the patch",
          loc(s, r.offset),
        ),
      );
  }
  return { diagnostics: out, manifest: s.manifest, manifestText: s.manifestText };
}

function relativeToManifest(s: State, path: string): string {
  return relative(dirname(s.manifest), path).split("\\").join("/");
}
