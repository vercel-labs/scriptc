/* Ask-5 determinism fences + the generalized teaching decoration.
 *
 * The profile's `determinism.fences` array denies surfaces BY SURFACE-
 * MANIFEST ID (coverage/surface-manifest.ts — the compiler's one stable
 * surface taxonomy; no new vocabulary). Resolution happens at profile
 * load, against the manifest generated from this compiler's own tables:
 *
 *   - an `id` names exactly one manifest entry; a `prefix` fences every
 *     entry it string-prefixes. An id or prefix matching NOTHING refuses
 *     loudly at load (ratified): fences pin to a compiler release's
 *     manifest, and a silently-inert fence is a footgun, so there is no
 *     forward-compatible acceptance of unknown selectors.
 *   - a fenced entry the static tier refuses anyway (status not "static")
 *     needs no new machinery: the surface's own refusal fires, and the
 *     fence's teaching rides it as the attributed note (spec §1: "changes
 *     only the message").
 *   - a fenced STATIC entry is policed against the COMPILED module graph:
 *     the emit pass lowers only reachability-discovered bodies, so the
 *     module IR *is* the reached graph — the same ground the sidecar's
 *     `deterministic` attestation stands on (ir/nodes.ts's
 *     moduleLibNondeterministicSurface). Fence evaluation reuses that
 *     posture with one generic walk collecting the reached surface facts
 *     (libCall spellings, str/arr/map/set intrinsic methods); each fenced
 *     entry then answers by table-derived detector. Unreached fences cost
 *     exactly this one walk — and no walk at all when no fence declares a
 *     detector-backed surface.
 *   - a fenced static entry with NO honest detector refuses at load,
 *     never accepted-and-ignored. Two families are named specifically:
 *     compile-time-folded constants (os.EOL, path.sep — the artifact
 *     performs no runtime read a fence could deny) and desugared surfaces
 *     (array map/filter/forEach and friends lower to plain loops with no
 *     distinct trace).
 *
 * Detectors derive MECHANICALLY from the same lowering tables the
 * manifest projects from (frontend/lowering/surfaces.ts), so a table row
 * added later grows the fenceable surface without hand maintenance. Two
 * aliased-lowering facts are inherited from the tables and deliberate:
 * string trimLeft/trimRight share trimStart/trimEnd's IR method, and
 * querystring decode/encode share parse/stringify's libCall — fencing one
 * spelling fences the operation.
 *
 * decorateLibraryRefusals is the generalized teaching rider (spec §2):
 * profile text attaches to ANY library-mode refusal by diagnostic code
 * (the ratified SC4004/SC4005 rider's keys, "async" shared-key fallback
 * included), by manifest id (matched against the refusal's code plus the
 * entry's surface name in the message; diagnostic-fence entries match on
 * code alone — the entry IS the code family), or by a fence entry
 * covering the refused surface. The text renders as the diagnostic's
 * `note`, always prefixed with the profile's name — the tool's message
 * stays the tool's. */
import { generateSurfaceManifest, type SurfaceEntryKind, type SurfaceManifestEntry } from "../coverage/surface-manifest.js";
import { libFenceDiag, type ScrDiagnostic } from "../diagnostics/diagnostic.js";
import {
  AMBIENT_SURFACE_FNS,
  BUILTIN_MODULE_CONSTS,
  BUILTIN_MODULE_FNS,
  BUILTIN_MODULE_FN_ALIASES,
  STATIC_MATH_FNS,
  STATIC_NUMBER_METHODS,
  STR_METHODS,
} from "../frontend/lowering/surfaces.js";
import type { IrModule, SrcLoc } from "../ir/nodes.js";
import { compilerReleaseVersion } from "./sidecar.js";

/** One raw fence declaration as the profile spelled it (validated for
 * shape by the loader; resolved here against the manifest). */
export interface LibraryFenceDecl {
  /** JSON path for exact-path refusals: `determinism.fences[2]`. */
  path: string;
  id?: string;
  prefix?: string;
  teaching?: string;
  remediation?: string;
}

/** The IR facts that witness one surface's reach in the compiled graph.
 * A surface is reached exactly when any listed fact appears. */
interface SurfaceDetector {
  libFns?: readonly string[];
  strMethods?: readonly string[];
  arrMethods?: readonly string[];
  mapMethods?: readonly string[];
  setMethods?: readonly string[];
}

/** One manifest entry a fence covers, resolved and load-validated. */
export interface FencedSurface {
  id: string;
  name: string;
  kind: SurfaceEntryKind;
  /** The diagnostic code the manifest entry carries (every non-static
   * entry has one) — the code whose refusal the fence teaching rides. */
  code?: string;
  /** Present exactly when the entry is static (it compiles, so the fence
   * must deny it): the reach witness. Absent = the surface already
   * refuses with `code` and the fence changes only the message. */
  detector?: SurfaceDetector;
}

export interface ResolvedLibraryFence {
  /** The declared selector, for messages: `id 'stdlib.math.random'` or
   * `prefix 'node-builtin.fs.'`. */
  declared: string;
  teaching?: string;
  remediation?: string;
  surfaces: readonly FencedSurface[];
}

/* ── the taxonomy: this release's manifest, indexed once ──────────────── */

interface FenceTaxonomy {
  byId: Map<string, SurfaceManifestEntry>;
  ids: readonly string[];
  /** node-builtin member id → libCall fn spellings (platform twins
   * included: a fence covers the surface on every target). */
  builtinFns: Map<string, readonly string[]>;
  /** node-builtin module-root id → the union of its members' spellings. */
  builtinRoots: Map<string, readonly string[]>;
  /** node-builtin constant ids: reads fold to literals at compile time. */
  foldedIds: Set<string>;
  /** Ambient dedicated-path surfaces (Date/perf_hooks/process): manifest
   * id → the libCall spellings witnessing reach (AMBIENT_SURFACE_FNS —
   * the same rows the manifest projects the entries from). */
  ambientFns: Map<string, readonly string[]>;
}

let taxonomy: FenceTaxonomy | null = null;

/** The taxonomy is a compilation-session view of the release manifest. */
export function clearFenceEvalCaches(): void {
  taxonomy = null;
}

function builtinRootId(mod: string): string {
  return `node-builtin.${mod.split("/").join(".")}`;
}

function fenceTaxonomy(): FenceTaxonomy {
  if (taxonomy !== null) return taxonomy;
  const manifest = generateSurfaceManifest(compilerReleaseVersion());
  const byId = new Map(manifest.entries.map((e) => [e.id, e]));
  const builtinFns = new Map<string, readonly string[]>();
  const builtinRoots = new Map<string, readonly string[]>();
  const foldedIds = new Set<string>();
  for (const [mod, members] of Object.entries(BUILTIN_MODULE_FNS)) {
    const root = new Set<string>();
    for (const [member, entry] of Object.entries(members!)) {
      if (entry === undefined) continue;
      const fns = new Set([entry.fn]);
      // The bare-path and url tables rebind per TARGET platform
      // (builtinModuleFnsOf): a fence on the bare id covers both flavors.
      if (mod === "path") {
        const w = BUILTIN_MODULE_FNS["path/win32"]?.[member];
        if (w !== undefined) fns.add(w.fn);
      }
      if (mod === "url" && member === "pathToFileURL") fns.add("url.pathToFileURLWin32");
      // Alternate spellings the dispatch special-cases around the table
      // row (Buffer/fd/options forms) are the same surface.
      for (const alias of BUILTIN_MODULE_FN_ALIASES[mod]?.[member] ?? []) fns.add(alias);
      builtinFns.set(`${builtinRootId(mod)}.${member}`, [...fns]);
      for (const f of fns) root.add(f);
    }
    if (root.size > 0) builtinRoots.set(builtinRootId(mod), [...root]);
  }
  for (const [mod, members] of Object.entries(BUILTIN_MODULE_CONSTS)) {
    for (const member of Object.keys(members!)) foldedIds.add(`${builtinRootId(mod)}.${member}`);
  }
  const ambientFns = new Map(AMBIENT_SURFACE_FNS.map((row) => [row.id, row.fns as readonly string[]]));
  taxonomy = { byId, ids: manifest.entries.map((e) => e.id), builtinFns, builtinRoots, foldedIds, ambientFns };
  return taxonomy;
}

/* ── classification: what policing a static entry means ───────────────── */

/** Array methods whose distinct arrIntrinsic traces can be policed. The
 * variadic inserters include their spread spellings under the same surface. */
const ARR_DETECTABLE: Record<string, readonly string[] | undefined> = {
  push: ["push", "pushSpread"],
  unshift: ["unshift", "unshiftSpread"],
  pop: ["pop"],
  reverse: ["reverse"],
  indexOf: ["indexOf"],
  includes: ["includes"],
  join: ["join"],
  slice: ["slice"],
};

const MAP_DETECTABLE = new Set(["get", "set", "has", "delete", "clear"]);
const SET_DETECTABLE = new Set(["add", "has", "delete", "clear"]);

type SurfaceClass =
  | { kind: "detector"; detector: SurfaceDetector }
  | { kind: "refusal" }
  | { kind: "unfenceable"; why: string };

const DESUGARED_WHY =
  "it desugars at compile time into plain loops over iteration primitives, so the compiled graph carries no distinct trace to police";

function classifySurface(entry: SurfaceManifestEntry, tax: FenceTaxonomy): SurfaceClass {
  // Non-static entries already refuse with their own code wherever they
  // are reached — the fence's teaching rides that refusal.
  if (entry.status !== "static") return { kind: "refusal" };
  if (tax.foldedIds.has(entry.id)) {
    return {
      kind: "unfenceable",
      why: "reads of it fold to a per-binary constant at compile time — the artifact performs no runtime read a fence could deny",
    };
  }
  // Ambient dedicated-path surfaces (Date/perf_hooks/process): the row
  // that projected the entry carries its reach witness.
  const ambient = tax.ambientFns.get(entry.id);
  if (ambient !== undefined) return { kind: "detector", detector: { libFns: ambient } };
  const builtinFns = tax.builtinFns.get(entry.id);
  if (builtinFns !== undefined) return { kind: "detector", detector: { libFns: builtinFns } };
  const rootFns = tax.builtinRoots.get(entry.id);
  if (rootFns !== undefined) return { kind: "detector", detector: { libFns: rootFns } };
  const [, family, member] = entry.id.split(".");
  if (entry.id.startsWith("stdlib.") && family !== undefined && member !== undefined) {
    if (family === "math") {
      const fn = Object.hasOwn(STATIC_MATH_FNS, member) ? STATIC_MATH_FNS[member] : undefined;
      if (fn !== undefined) return { kind: "detector", detector: { libFns: [fn.fn] } };
    }
    if (family === "number") {
      const method = Object.hasOwn(STATIC_NUMBER_METHODS, member)
        ? STATIC_NUMBER_METHODS[member]
        : undefined;
      if (method !== undefined) {
        return { kind: "detector", detector: { libFns: method.fns } };
      }
    }
    if (family === "string") {
      const m = Object.hasOwn(STR_METHODS, member) ? STR_METHODS[member] : undefined;
      if (m !== undefined) return { kind: "detector", detector: { strMethods: [m.method] } };
    }
    if (family === "array") {
      const methods = Object.hasOwn(ARR_DETECTABLE, member) ? ARR_DETECTABLE[member] : undefined;
      if (methods !== undefined) return { kind: "detector", detector: { arrMethods: methods } };
      return { kind: "unfenceable", why: DESUGARED_WHY };
    }
    if (family === "map") {
      if (MAP_DETECTABLE.has(member)) return { kind: "detector", detector: { mapMethods: [member] } };
      return { kind: "unfenceable", why: DESUGARED_WHY };
    }
    if (family === "set") {
      if (SET_DETECTABLE.has(member)) return { kind: "detector", detector: { setMethods: [member] } };
      return { kind: "unfenceable", why: DESUGARED_WHY };
    }
  }
  if (entry.id.startsWith("syntax.")) {
    return {
      kind: "unfenceable",
      why: "it lowers to the same IR as its expanded spelling, so the compiled graph carries no distinct trace to police",
    };
  }
  if (entry.id.startsWith("node-builtin.")) {
    return {
      kind: "unfenceable",
      why: "its lowered surface leaves no tabled per-call trace at this compiler release — fence the member entries the manifest projects instead",
    };
  }
  return { kind: "unfenceable", why: "no fence detector exists for it at this compiler release" };
}

/* ── load-time resolution ──────────────────────────────────────────────── */

/** Resolve the profile's fence declarations against this compiler
 * release's surface manifest. Every failure returns the exact-path detail
 * the loader wraps as SC4001. Selector strictness is RATIFIED: an id or
 * prefix matching nothing refuses; a covered static entry no detector can
 * police refuses (loudly, never silently inert). Compile-time-folded
 * constants refuse as `id` fences (the message says why) and are exempt
 * under a `prefix` — the family sweep stays usable, and the fold means
 * there is genuinely nothing at runtime to deny. */
export function resolveLibraryFences(
  decls: readonly LibraryFenceDecl[],
): { ok: true; fences: ResolvedLibraryFence[] } | { ok: false; detail: string } {
  const tax = fenceTaxonomy();
  const fences: ResolvedLibraryFence[] = [];
  for (const d of decls) {
    const surfaces: FencedSurface[] = [];
    const keep = (entry: SurfaceManifestEntry, cls: SurfaceClass): void => {
      surfaces.push({
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        ...(entry.code !== undefined ? { code: entry.code } : {}),
        ...(cls.kind === "detector" ? { detector: cls.detector } : {}),
      });
    };
    if (d.id !== undefined) {
      const entry = tax.byId.get(d.id);
      if (entry === undefined) {
        return {
          ok: false,
          detail:
            `'${d.path}.id' names no entry in this compiler release's surface manifest ('${d.id}') — ` +
            `fences pin to the release's manifest ids (the package ships surface-manifest.json), and an unknown id is refused, never accepted as inert`,
        };
      }
      const cls = classifySurface(entry, tax);
      if (cls.kind === "unfenceable") {
        return { ok: false, detail: `'${d.path}.id' names '${d.id}', which cannot be fenced: ${cls.why}` };
      }
      keep(entry, cls);
    } else {
      const covered = tax.ids.filter((id) => id.startsWith(d.prefix!));
      if (covered.length === 0) {
        return {
          ok: false,
          detail:
            `'${d.path}.prefix' matches no entry in this compiler release's surface manifest ('${d.prefix}') — ` +
            `fences pin to the release's manifest ids (the package ships surface-manifest.json), and an unknown prefix is refused, never accepted as inert`,
        };
      }
      for (const id of covered) {
        const entry = tax.byId.get(id)!;
        const cls = classifySurface(entry, tax);
        if (cls.kind === "unfenceable") {
          if (tax.foldedIds.has(id)) continue; // the fold IS the exemption — see above
          return { ok: false, detail: `'${d.path}.prefix' ('${d.prefix}') covers '${id}', which cannot be fenced: ${cls.why}` };
        }
        keep(entry, cls);
      }
      if (surfaces.length === 0) {
        return {
          ok: false,
          detail: `'${d.path}.prefix' ('${d.prefix}') covers only compile-time-folded constants — there is nothing at runtime for the fence to deny`,
        };
      }
    }
    fences.push({
      declared: d.id !== undefined ? `id '${d.id}'` : `prefix '${d.prefix}'`,
      ...(d.teaching !== undefined ? { teaching: d.teaching } : {}),
      ...(d.remediation !== undefined ? { remediation: d.remediation } : {}),
      surfaces,
    });
  }
  return { ok: true, fences };
}

/* ── compile-time evaluation over the reached graph ────────────────────── */

interface ReachedSurfaces {
  libFns: Map<string, SrcLoc>;
  strMethods: Map<string, SrcLoc>;
  arrMethods: Map<string, SrcLoc>;
  mapMethods: Map<string, SrcLoc>;
  setMethods: Map<string, SrcLoc>;
}

/** One generic walk over the compiled module (the moduleLibAsyncSurface
 * shape: nearest enclosing `loc` tracked so refusals anchor at the
 * reaching construct), collecting every reached surface fact the fence
 * detectors speak. First location per fact wins. */
function collectReachedSurfaces(mod: IrModule): ReachedSurfaces {
  const reached: ReachedSurfaces = {
    libFns: new Map(),
    strMethods: new Map(),
    arrMethods: new Map(),
    mapMethods: new Map(),
    setMethods: new Map(),
  };
  const note = (map: Map<string, SrcLoc>, key: string, loc: SrcLoc): void => {
    if (!map.has(key)) map.set(key, loc);
  };
  const entryLoc: SrcLoc = { file: mod.sourceFile, start: 0, end: 0 };
  const visit = (v: unknown, loc: SrcLoc): void => {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item, loc);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown; method?: unknown; loc?: SrcLoc };
    const here = node.loc ?? loc;
    if (typeof node.kind === "string") {
      if (node.kind === "libCall" && typeof node.fn === "string") note(reached.libFns, node.fn, here);
      else if (typeof node.method === "string") {
        if (node.kind === "strIntrinsic") note(reached.strMethods, node.method, here);
        else if (node.kind === "arrIntrinsic") note(reached.arrMethods, node.method, here);
        else if (node.kind === "mapIntrinsic") note(reached.mapMethods, node.method, here);
        else if (node.kind === "setIntrinsic") note(reached.setMethods, node.method, here);
      }
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key], here);
  };
  visit(mod, entryLoc);
  return reached;
}

function detectorHit(reached: ReachedSurfaces, det: SurfaceDetector): SrcLoc | null {
  const scan = (facts: Map<string, SrcLoc>, keys: readonly string[] | undefined): SrcLoc | null => {
    for (const k of keys ?? []) {
      const loc = facts.get(k);
      if (loc !== undefined) return loc;
    }
    return null;
  };
  return (
    scan(reached.libFns, det.libFns) ??
    scan(reached.strMethods, det.strMethods) ??
    scan(reached.arrMethods, det.arrMethods) ??
    scan(reached.mapMethods, det.mapMethods) ??
    scan(reached.setMethods, det.setMethods)
  );
}

/** The structural slice of LibraryProfile the fence machinery reads —
 * kept structural so this module never value-imports the loader. */
export interface FenceProfileView {
  name: string;
  teachings: Readonly<Record<string, string>>;
  fences: readonly ResolvedLibraryFence[];
}

/** Evaluate the profile's fences against the COMPILED module graph: every
 * fenced static surface the graph reaches refuses as SC4008, anchored at
 * the reaching construct, the fence's teaching attached as the attributed
 * note. Unreached fences add nothing; a profile whose fences carry no
 * detector-backed surface skips the walk entirely. */
export function evaluateLibraryFences(mod: IrModule, profile: FenceProfileView): ScrDiagnostic[] {
  if (!profile.fences.some((f) => f.surfaces.some((s) => s.detector !== undefined))) return [];
  const reached = collectReachedSurfaces(mod);
  const diags: ScrDiagnostic[] = [];
  const seen = new Set<string>();
  for (const fence of profile.fences) {
    for (const s of fence.surfaces) {
      if (s.detector === undefined || seen.has(s.id)) continue;
      const loc = detectorHit(reached, s.detector);
      if (loc === null) continue;
      seen.add(s.id);
      diags.push(libFenceDiag(profile.name, s.id, s.name, loc, s.code, fence.teaching));
    }
  }
  return diags;
}

/* ── the generalized teaching rider ────────────────────────────────────── */

function surfaceMatchesDiag(
  surface: { code?: string; name: string; kind: SurfaceEntryKind },
  diag: ScrDiagnostic,
): boolean {
  if (surface.code === undefined || surface.code !== diag.code) return false;
  // A diagnostic-fence entry IS the code family; member entries must also
  // appear by name in the refusal's message (SC2020/SC2012 refusals spell
  // the surface exactly as the manifest names it).
  return surface.kind === "diagnostic-fence" || diag.message.includes(surface.name);
}

function teachingForRefusal(profile: FenceProfileView, diag: ScrDiagnostic): string | undefined {
  // 1. Code-keyed teachings — the ratified SC4004/SC4005 rider's keys,
  // "async" shared-key fallback included (profile.ts's profileTeaching
  // rule, restated here to keep the import graph acyclic).
  const direct =
    profile.teachings[diag.code] ??
    (diag.code === "SC4004" || diag.code === "SC4005" ? profile.teachings["async"] : undefined);
  if (direct !== undefined) return direct;
  // 2. Manifest-id-keyed teachings (dotted keys — embedder refusal-code
  // tokens never carry dots; an id key resolves against the taxonomy and
  // attaches where that surface's refusal fired).
  for (const [key, text] of Object.entries(profile.teachings)) {
    if (!key.includes(".")) continue;
    const entry = fenceTaxonomy().byId.get(key);
    if (entry !== undefined && surfaceMatchesDiag(entry, diag)) return text;
  }
  // 3. A fence covering the refused surface: the teaching rides the
  // surface's own refusal (the non-static half of fence coverage).
  for (const fence of profile.fences) {
    if (fence.teaching === undefined) continue;
    for (const s of fence.surfaces) {
      if (surfaceMatchesDiag(s, diag)) return fence.teaching;
    }
  }
  return undefined;
}

/** Attach the profile's teaching text to every library-mode refusal it
 * names — by code, by manifest id, or through a fence — as the visibly
 * attributed `note`. Diagnostics already carrying a note (SC4008 threads
 * its fence's teaching at mint time) pass through unchanged. */
export function decorateLibraryRefusals(
  diagnostics: ScrDiagnostic[],
  profile: FenceProfileView,
): ScrDiagnostic[] {
  if (Object.keys(profile.teachings).length === 0 && profile.fences.length === 0) return diagnostics;
  return diagnostics.map((d) => {
    if (d.note !== undefined) return d;
    const teaching = teachingForRefusal(profile, d);
    if (teaching === undefined) return d;
    return { ...d, note: `from the '${profile.name}' profile: ${teaching}` };
  });
}
