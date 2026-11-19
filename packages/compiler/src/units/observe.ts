/* SCRIPTC_UNITS=observe (M0): after a normal build lowered the program,
 * compute the unit graph, each unit's key and summary, write them to the unit
 * store, and print one `scriptc units {…}` line on stderr.
 *
 * The output is a report. It changes no IR, no executable and no diagnostic;
 * the units written to the store are M1's inputs, and the line is what
 * measures how much of the SDK's lowering facts change from one app to
 * another. */

import { performance } from "node:perf_hooks";
import { canonicalJson, type CanonicalValue } from "./canonical.js";
import { buildUnitGraph, unitIdByFile } from "./graph.js";
import { digestOfText, loweringKeyValue, unitKey, unitKeyParts, type UnitKeyInput } from "./key.js";
import { buildUnitSummary, summaryText } from "./summary.js";
import { protectUnitEntry, readUnitEntry, unitsStoreRoot, writeUnitEntry } from "./store.js";
import type {
  UnitFactValue,
  UnitGraph,
  UnitNode,
  UnitObservation,
  UnitObservationInput,
  UnitStoreMeta,
  UnitSummary,
} from "./types.js";

/** What the host knows that the observation does not: the build identity and
 * the inputs the key names. */
export interface UnitsHostContext {
  compilerIdentity: string | null;
  /** The target triple, or the build platform when no triple is known. */
  target: string;
  optimization: string;
  /** `loweringOptions(opts)`. */
  lowering: unknown;
  /** The FFI profile's bytes digest, or null. */
  ffiDigest: string | null;
  environment: readonly (readonly [string, string])[];
  /** The unit store root the host prepared, when it differs from the
   * process default (the build cache root, `units-v2`). */
  storeRoot?: string | null;
}

/** One unit's observation result. */
export interface UnitReportEntry {
  id: string;
  app: boolean;
  files: number;
  key: string;
  summaryDigest: string;
  summaryBytes: number;
  /** Whether the store already held this key before this build wrote it. */
  existed: boolean;
  /** Whether that stored summary matched this build's (null when none was
   * stored or the mode wrote no store). */
  digestMatched: boolean | null;
  /** Whether a later build would reuse the stored entry: the key matched
   * (this entry was read at this build's own key) and every pin matched.
   * Null when no entry was stored at this key. */
  wouldHit: boolean | null;
  /** Whether the entry's pins match this build's (null with `wouldHit`). */
  pinsEqual: boolean | null;
  /** The facts this build read whose setting occurrence M1 cannot attribute
   * to a file. Their values are pinned (they are in the comparison); the
   * attribution is what M1-3's base-union-app rule needs. */
  unattributedFacts: readonly string[];
}

export interface UnitsReport {
  graph: UnitGraph;
  entries: readonly UnitReportEntry[];
  timings: { graphMs: number; summaryMs: number; keyMs: number; totalMs: number };
  /** Total summary bytes written or computed. */
  summaryBytes: number;
  /** The store root used, or null when the build had no shared cache. */
  storeRoot: string | null;
}

/** The module → unit map the summary uses for demand attribution and file
 * filtering. A relative path two packages share resolves to the first unit
 * in graph order; the graph itself stays the authority for a unit's files. */
function modulesByUnit(graph: UnitGraph): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of graph.units)
    for (const file of node.files) if (!out.has(file)) out.set(file, node.id);
  return out;
}

/** The files of each unit with their content digests. A unit whose package
 * directory the host listed takes its file set from that directory (the
 * package as installed, whether or not this build reached each file); the
 * app unit and any unit the host did not list take the files this build
 * reached. A merged unit may list two copies of one relative path; both
 * pairs stay, sorted. */
function filesOfUnits(
  input: UnitObservationInput,
  graph: UnitGraph,
): Map<string, [string, string][]> {
  const fileUnit = unitIdByFile(input, graph);
  const packages = new Map((input.packages ?? []).map((directory) => [directory.root, directory]));
  const out = new Map<string, [string, string][]>();
  for (const node of graph.units) {
    // A unit that includes the app keeps the files this build reached (see
    // the graph's rule): the app's files are part of its identity.
    if (node.app) continue;
    const roots = new Set<string>();
    for (const file of input.files)
      if (file.packageRoot !== null && fileUnit.get(file.file) === node.id)
        roots.add(file.packageRoot);
    const installed: [string, string][] = [];
    for (const root of roots)
      for (const file of packages.get(root)?.files ?? [])
        installed.push([file.relative, file.digest]);
    if (installed.length === 0) continue;
    out.set(
      node.id,
      installed.sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  // Every reached file of a unit the host did not list belongs in its key. A
  // unit's files are all collected before it is recorded: setting the entry
  // on the first file would make every later file look already held and its
  // edits would leave the key unchanged.
  const reached = new Map<string, [string, string][]>();
  for (const file of input.files) {
    const id = fileUnit.get(file.file);
    if (id === undefined || out.has(id)) continue;
    const list = reached.get(id) ?? [];
    list.push([file.relative, file.digest]);
    reached.set(id, list);
  }
  for (const [id, list] of reached) out.set(id, list);
  for (const list of out.values()) list.sort(([a], [b]) => a.localeCompare(b));
  return out;
}

/** The part of a summary a pin comparison reads. */
type PinSource = Pick<UnitSummary, "pins" | "facts">;

/** The pin vector a summary carries: the fields a warm build compares before
 * reusing a stored unit.
 *
 * The facts compare by VALUE, not by attribution. A fact's value is the
 * decision every reader acts on, so equal values mean equal lowered code
 * whether or not this build can say which unit's files set it. Attribution
 * (`setByOwnFiles`) is recorded for M1-3's base-union-app comparison, where a
 * warm build has no whole-program value to compare; until that exists, a
 * warm build only reuses a unit whose whole-program fact values match, which
 * is the conservative rule. */
function pinVector(summary: PinSource): CanonicalValue {
  return {
    pins: {
      functions: [...summary.pins.functions],
      classes: summary.pins.classes.map((entry) => ({ name: entry.name, id: entry.id })),
    },
    facts: Object.keys(summary.facts)
      .sort()
      .map((name) => ({ name, value: summary.facts[name]!.value })),
  };
}

/** Whether two pin vectors agree, by their canonical text. */
function pinsMatch(a: PinSource, b: PinSource): boolean {
  return canonicalJson(pinVector(a)) === canonicalJson(pinVector(b));
}

/** A stored summary's pins, or null when it is not a v1 summary this build
 * can compare (an older schema, a truncated write). Any such entry is a
 * miss rather than a guess. */
function parseStoredPins(text: string): PinSource | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record["schema"] !== "scriptc.unit-summary.v1") return null;
  const pins = record["pins"];
  if (pins === null || typeof pins !== "object" || Array.isArray(pins)) return null;
  const pinRecord = pins as Record<string, unknown>;
  const functions = pinRecord["functions"];
  const classes = pinRecord["classes"];
  const facts = record["facts"];
  if (!Array.isArray(functions) || !functions.every((name) => typeof name === "string"))
    return null;
  if (
    !Array.isArray(classes) ||
    !classes.every((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
      const value = entry as Record<string, unknown>;
      return typeof value["name"] === "string" && typeof value["id"] === "number";
    })
  )
    return null;
  if (facts === null || typeof facts !== "object" || Array.isArray(facts)) return null;
  const factValues: Record<string, UnitFactValue> = {};
  for (const [name, value] of Object.entries(facts as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const fact = value as Record<string, unknown>;
    if (typeof fact["value"] !== "string") return null;
    const attribution = fact["setByOwnFiles"];
    if (attribution !== true && attribution !== false && attribution !== "unobserved") return null;
    factValues[name] = { value: fact["value"], setByOwnFiles: attribution };
  }
  return {
    pins: {
      functions: functions as string[],
      classes: classes as { name: string; id: number }[],
    },
    facts: factValues,
  };
}

/** The facts this build read whose occurrence M1 cannot attribute to a file.
 * Their values still pin the output; their attribution is what M1-3's
 * base-union-app rule needs. */
function unattributedFacts(facts: Record<string, UnitFactValue>): string[] {
  return Object.keys(facts)
    .filter((name) => {
      const fact = facts[name]!;
      return fact.value !== "unobserved" && fact.setByOwnFiles === "unobserved";
    })
    .sort();
}

/** Compute the graph, summaries and keys, write the store entries, and print
 * the observation line. Returns the report for the caller's own timing
 * output. */
export function observeUnits(
  observation: UnitObservation,
  context: UnitsHostContext,
  protectedPaths?: Set<string>,
): UnitsReport {
  const started = performance.now();
  const input: UnitObservationInput = {
    entry: observation.entry,
    files: observation.files,
    edges: observation.edges,
    ...(observation.packages === undefined ? {} : { packages: observation.packages }),
  };
  const graph = buildUnitGraph(input);
  const graphMs = performance.now() - started;
  const unitOfModule = modulesByUnit(graph);
  const byModule = (module: string): string | null => unitOfModule.get(module) ?? null;

  const summaryStarted = performance.now();
  const summaries = new Map<string, { summary: UnitSummary; text: string; digest: string }>();
  for (const node of graph.units) {
    const summary = buildUnitSummary(node, observation, byModule);
    const text = summaryText(summary);
    summaries.set(node.id, { summary, text, digest: digestOfText(text) });
  }
  const summaryMs = performance.now() - summaryStarted;

  const keyStarted = performance.now();
  const filesByUnit = filesOfUnits(input, graph);
  const keys = new Map<string, string>();
  const keyInputs = new Map<string, UnitKeyInput>();
  const lowering = loweringKeyValue(context.lowering as Record<string, unknown>);
  for (const node of graph.units) {
    const keyInput: UnitKeyInput = {
      unit: { id: node.id, name: node.name, version: node.version },
      compiler: context.compilerIdentity,
      target: context.target,
      optimization: context.optimization,
      lowering,
      ffi: context.ffiDigest,
      environment: context.environment,
      files: filesByUnit.get(node.id) ?? [],
      dependencies: node.dependencies.map((id) => [id, summaries.get(id)?.digest ?? ""] as const),
    };
    keyInputs.set(node.id, keyInput);
    keys.set(node.id, unitKey(keyInput));
  }
  const keyMs = performance.now() - keyStarted;

  const storeRoot = context.storeRoot === undefined ? unitsStoreRoot() : context.storeRoot;
  const entries: UnitReportEntry[] = [];
  let summaryBytes = 0;
  for (const node of graph.units) {
    const summary = summaries.get(node.id)!;
    const key = keys.get(node.id)!;
    const summaryBytesOfThis = Buffer.byteLength(summary.text, "utf8");
    summaryBytes += summaryBytesOfThis;
    const stored = storeRoot === null ? null : readUnitEntry(storeRoot, key);
    const existed = stored !== null;
    const digestMatched = stored === null ? null : digestOfText(stored.summary) === summary.digest;
    // `wouldHit`: a later build finds an entry at this same key (so the key
    // matched) whose pins match. The stored entry is parsed rather than
    // trusted: a malformed or older summary is a miss.
    let wouldHit: boolean | null = null;
    let pinsEqual: boolean | null = null;
    if (stored !== null) {
      const previous = parseStoredPins(stored.summary);
      pinsEqual = previous === null ? false : pinsMatch(previous, summary.summary);
      wouldHit = pinsEqual;
    }
    const unattributed = unattributedFacts(summary.summary.facts);
    if (storeRoot !== null) {
      const meta: UnitStoreMeta = {
        schema: "scriptc.unit-meta.v0",
        key,
        summaryDigest: summary.digest,
        summaryBytes: summaryBytesOfThis,
        unit: node,
        compiler: context.compilerIdentity,
        keyParts: unitKeyParts(keyInputs.get(node.id)!),
        timings: { graphMs, summaryMs, keyMs },
      };
      try {
        writeUnitEntry(storeRoot, key, summary.text, meta);
        if (protectedPaths !== undefined) protectUnitEntry(storeRoot, key, protectedPaths);
      } catch {
        /* the store is an optimization; the summary was already computed */
      }
    }
    entries.push({
      id: node.id,
      app: node.app,
      files: node.files.length,
      key,
      summaryDigest: summary.digest,
      summaryBytes: summaryBytesOfThis,
      existed,
      digestMatched,
      wouldHit,
      pinsEqual,
      unattributedFacts: unattributed,
    });
  }
  const timings = {
    graphMs: Math.round(graphMs * 100) / 100,
    summaryMs: Math.round(summaryMs * 100) / 100,
    keyMs: Math.round(keyMs * 100) / 100,
    totalMs: Math.round((performance.now() - started) * 100) / 100,
  };
  const report: UnitsReport = { graph, entries, timings, summaryBytes, storeRoot };
  const line = {
    mode: "observe",
    units: graph.units.map((node: UnitNode) => ({
      id: node.id,
      app: node.app,
      files: node.files.length,
      dependencies: node.dependencies,
    })),
    files: graph.stats.files,
    sccMerges: graph.sccMerges,
    genericDemands: observation.lowering.generics.demands.length,
    summaryBytes,
    time: timings,
    entries: entries.map((entry) => ({
      id: entry.id,
      app: entry.app,
      existed: entry.existed,
      digestMatched: entry.digestMatched,
      wouldHit: entry.wouldHit,
      pinsEqual: entry.pinsEqual,
      // A hit is usable: the comparison covers every value that decides the
      // unit's output. `unattributedFacts` says which facts M1-3 will have to
      // attribute before it can compare a base contribution against an app's.
      safeToUse: entry.wouldHit === true,
      unattributedFacts: entry.unattributedFacts,
    })),
  };
  process.stderr.write(`scriptc units ${JSON.stringify(line)}\n`);
  return report;
}
