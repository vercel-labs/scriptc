/* The coverage verdict cache: `scriptc coverage` on an unchanged program
 * replays the previous analysis instead of lowering the whole program
 * again. The entry records every filesystem observation the analysis made
 * (the frontend input tracker's probes — the same evidence the executable
 * cache trusts) plus the compiler identity and the analysis options; a
 * rerun replays the probes and reuses the verdict only when all of them
 * still hold. With a semantic matcher (the Node frontend's), edits that
 * only touch TypeScript comments also reuse it, with every reported
 * location moved to the edited text. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnalyzeOptions, AnalyzeResult } from "../compile-types.js";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { LowerStats } from "../frontend/lowering/lowerer.js";
import type { NpmStaticStatus } from "./report.js";
import {
  FrontendInputTracker,
  frontendInputsStillMatch,
  type FrontendInputSnapshot,
} from "../frontend/input-tracker.js";

const SCHEMA = "scriptc.coverage-verdict.v1";

/** Key-value storage for verdict entries (best effort: failures miss). */
export interface VerdictStore {
  read(key: string): string | null;
  write(key: string, text: string): void;
}

/** The cacheable part of a coverage analysis: JSON-shaped fields only. An
 * analysis that carries anything else (npm builtin tables, provenance)
 * is not cached. */
export interface CachedCoverage {
  file: string;
  dynamic: boolean;
  stats: LowerStats;
  diagnostics: ScrDiagnostic[];
  runtimeFences?: ScrDiagnostic[];
  unreached?: { stats: LowerStats; diagnostics: ScrDiagnostic[]; runtimeFences?: ScrDiagnostic[] };
  divergences?: ScrDiagnostic[];
  npmStatic?: NpmStaticStatus[];
  preflightFailed: boolean;
}

export interface CachedSource {
  path: string;
  text: string;
}

export interface SemanticReplayResult {
  probes: FrontendInputSnapshot;
  sources: CachedSource[];
  coverage: CachedCoverage;
}

/** A semantic replay: the entry's probes still hold once the listed
 * sources are allowed to differ by comments; the coverage comes back with
 * its locations moved to the current text. Null when it does not apply. */
export type SemanticReplay = (
  probes: FrontendInputSnapshot,
  sources: CachedSource[],
  coverage: CachedCoverage,
) => SemanticReplayResult | null;

export interface VerdictCacheOptions {
  store: VerdictStore;
  /** The compiler implementation's identity (package digest or binary). */
  identity: string;
  /** The build's target platform: part of the analysis' meaning. */
  platform: string;
  semanticReplay?: SemanticReplay;
}

export type VerdictCacheOutcome = "hit" | "semantic-hit" | "miss" | "uncacheable";

interface VerdictEntry {
  schema: string;
  key: string;
  probes: FrontendInputSnapshot;
  coverage: CachedCoverage;
  sources: CachedSource[];
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function verdictKey(
  entry: string,
  opts: AnalyzeOptions,
  cache: VerdictCacheOptions,
): string | null {
  let ffi = "";
  if (opts.ffiProfilePath !== undefined) {
    try {
      ffi = digest(readFileSync(opts.ffiProfilePath, "utf8"));
    } catch {
      return null;
    }
  }
  const npmStatic =
    opts.npmStatic === undefined
      ? ""
      : typeof opts.npmStatic === "string"
        ? opts.npmStatic
        : opts.npmStatic.join(",");
  const external: string[] = [];
  const types = opts.externalTypes;
  if (types !== undefined) {
    for (const specifier of Object.keys(types).sort())
      external.push(`${specifier}=${types[specifier]}`);
  }
  return digest(
    [
      SCHEMA,
      cache.identity,
      cache.platform,
      process.env["SCRIPTC_TARGET"] ?? "",
      entry,
      opts.dynamic === true ? "dynamic" : "static",
      npmStatic,
      opts.ffiProfilePath ?? "",
      ffi,
      external.join("\n"),
    ].join("\0"),
  );
}

function cacheable(coverage: AnalyzeResult["coverage"]): CachedCoverage | null {
  if (
    coverage.provenance !== undefined ||
    coverage.statsByFile !== undefined ||
    coverage.provenanceElided !== undefined ||
    coverage.npmBuiltins !== undefined ||
    coverage.npmLazyTraps !== undefined
  )
    return null;
  const out: CachedCoverage = {
    file: coverage.file,
    dynamic: coverage.dynamic ?? false,
    stats: coverage.stats,
    diagnostics: coverage.diagnostics,
    preflightFailed: coverage.preflightFailed,
  };
  if (coverage.runtimeFences !== undefined) out.runtimeFences = coverage.runtimeFences;
  if (coverage.unreached !== undefined) out.unreached = coverage.unreached;
  if (coverage.divergences !== undefined) out.divergences = coverage.divergences;
  if (coverage.npmStatic !== undefined) out.npmStatic = coverage.npmStatic;
  return out;
}

function restore(cached: CachedCoverage, sources: CachedSource[]): AnalyzeResult {
  const sourceTexts = new Map<string, string>();
  for (const source of sources) sourceTexts.set(source.path, source.text);
  const coverage: AnalyzeResult["coverage"] = {
    file: cached.file,
    dynamic: cached.dynamic,
    stats: cached.stats,
    diagnostics: cached.diagnostics,
    preflightFailed: cached.preflightFailed,
  };
  if (cached.runtimeFences !== undefined) coverage.runtimeFences = cached.runtimeFences;
  if (cached.unreached !== undefined) coverage.unreached = cached.unreached;
  if (cached.divergences !== undefined) coverage.divergences = cached.divergences;
  if (cached.npmStatic !== undefined) coverage.npmStatic = cached.npmStatic;
  return { coverage, sourceTexts };
}

/** The cached analysis when an entry for the same inputs still holds
 * exactly; null otherwise. */
export function replayVerdict(
  entry: string,
  opts: AnalyzeOptions,
  cache: VerdictCacheOptions,
): AnalyzeResult | null {
  const key = verdictKey(entry, opts, cache);
  if (key === null) return null;
  const cached = readEntry(cache.store, key);
  if (cached === null || !frontendInputsStillMatch(cached.probes)) return null;
  return restore(cached.coverage, cached.sources);
}

/** Runs `analyze` unless an entry for the same inputs proves its verdict
 * still holds. */
export function analyzeWithVerdictCache(
  entry: string,
  opts: AnalyzeOptions,
  cache: VerdictCacheOptions,
  analyze: () => AnalyzeResult,
): { result: AnalyzeResult; outcome: VerdictCacheOutcome } {
  const key = verdictKey(entry, opts, cache);
  if (key === null) return { result: analyze(), outcome: "uncacheable" };
  const cached = readEntry(cache.store, key);
  if (cached !== null) {
    if (frontendInputsStillMatch(cached.probes)) {
      return { result: restore(cached.coverage, cached.sources), outcome: "hit" };
    }
    const replay = cache.semanticReplay;
    if (replay !== undefined) {
      const replayed = replay(cached.probes, cached.sources, cached.coverage);
      if (replayed !== null) {
        writeEntry(cache.store, key, replayed.probes, replayed.coverage, replayed.sources);
        return { result: restore(replayed.coverage, replayed.sources), outcome: "semantic-hit" };
      }
    }
  }
  const tracker = new FrontendInputTracker();
  const result = tracker.runSynchronous(analyze);
  const probes = tracker.snapshot();
  const stored = cacheable(result.coverage);
  if (stored !== null && probes.stable && frontendInputsStillMatch(probes)) {
    const sources: CachedSource[] = [];
    for (const [path, text] of result.sourceTexts) sources.push({ path, text });
    writeEntry(cache.store, key, probes, stored, sources);
  }
  return { result, outcome: "miss" };
}

function readEntry(store: VerdictStore, key: string): VerdictEntry | null {
  try {
    const text = store.read(key);
    if (text === null) return null;
    const entry = JSON.parse(text) as VerdictEntry;
    if (entry.schema !== SCHEMA || entry.key !== key) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeEntry(
  store: VerdictStore,
  key: string,
  probes: FrontendInputSnapshot,
  coverage: CachedCoverage,
  sources: CachedSource[],
): void {
  try {
    const entry: VerdictEntry = { schema: SCHEMA, key, probes, coverage, sources };
    store.write(key, JSON.stringify(entry));
  } catch {
    // A cache write failure never changes the analysis.
  }
}

/** A directory of `<key>.json` entries, published by rename so readers
 * never see a partial write. */
export function fileVerdictStore(directory: string): VerdictStore {
  return {
    read: (key) => {
      try {
        return readFileSync(join(directory, `${key}.json`), "utf8");
      } catch {
        return null;
      }
    },
    write: (key, text) => {
      let stage: string | null = null;
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        stage = mkdtempSync(join(directory, ".write-"));
        writeFileSync(join(stage, "entry"), text);
        renameSync(join(stage, "entry"), join(directory, `${key}.json`));
      } catch {
        // Best effort: a failed write is a later miss.
      } finally {
        if (stage !== null) rmSync(stage, { recursive: true, force: true });
      }
    },
  };
}
