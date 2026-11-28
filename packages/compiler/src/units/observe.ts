/* SCRIPTC_UNITS=observe (M0): after a normal build lowered the program,
 * compute the unit graph, each unit's key and summary, write them to the unit
 * store, and print one `scriptc units {…}` line on stderr.
 *
 * The output is a report. It changes no IR, no executable and no diagnostic;
 * the units written to the store are M1's inputs, and the line is what
 * measures how much of the SDK's lowering facts change from one app to
 * another. */

import { performance } from "node:perf_hooks";
import { buildUnitGraph, unitIdByFile } from "./graph.js";
import { digestOfText, loweringKeyValue, unitKey, unitKeyParts, type UnitKeyInput } from "./key.js";
import { buildUnitSummary, summaryText } from "./summary.js";
import { protectUnitEntry, readUnitEntry, unitsStoreRoot, writeUnitEntry } from "./store.js";
import type {
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

/** Which unit each absolute program file belongs to, and each unit's member
 * files. Identity is the file path: two packages can both contain
 * `index.ts`, so a relative module path cannot decide membership. */
function unitMembers(
  input: UnitObservationInput,
  graph: UnitGraph,
): { fileUnit: Map<string, string>; members: Map<string, Set<string>> } {
  const fileUnit = unitIdByFile(input, graph);
  const members = new Map<string, Set<string>>();
  for (const file of input.files) {
    const id = fileUnit.get(file.file);
    if (id === undefined) continue;
    const set = members.get(id) ?? new Set<string>();
    set.add(file.file);
    members.set(id, set);
  }
  return { fileUnit, members };
}

/** The files of each unit with their content digests, from the input records
 * (a merged unit may list two copies of one relative path; both pairs stay,
 * sorted). */
function filesOfUnits(
  input: UnitObservationInput,
  fileUnit: ReadonlyMap<string, string>,
): Map<string, [string, string][]> {
  const out = new Map<string, [string, string][]>();
  for (const file of input.files) {
    const id = fileUnit.get(file.file);
    if (id === undefined) continue;
    const list = out.get(id) ?? [];
    list.push([file.relative, file.digest]);
    out.set(id, list);
  }
  for (const list of out.values()) list.sort(([a], [b]) => a.localeCompare(b));
  return out;
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
  };
  const graph = buildUnitGraph(input);
  const graphMs = performance.now() - started;
  const membership = unitMembers(input, graph);
  const unitOfFile = (file: string): string | null => membership.fileUnit.get(file) ?? null;

  const summaryStarted = performance.now();
  const summaries = new Map<string, { summary: UnitSummary; text: string; digest: string }>();
  const empty = new Set<string>();
  for (const node of graph.units) {
    const summary = buildUnitSummary(
      node,
      observation,
      membership.members.get(node.id) ?? empty,
      unitOfFile,
    );
    const text = summaryText(summary);
    summaries.set(node.id, { summary, text, digest: digestOfText(text) });
  }
  const summaryMs = performance.now() - summaryStarted;

  const keyStarted = performance.now();
  const filesByUnit = filesOfUnits(input, membership.fileUnit);
  const keys = new Map<string, string>();
  const keyInputs = new Map<string, UnitKeyInput>();
  const lowering = loweringKeyValue(context.lowering as Record<string, unknown>);
  for (const node of graph.units) {
    const keyInput: UnitKeyInput = {
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
    })),
  };
  process.stderr.write(`scriptc units ${JSON.stringify(line)}\n`);
  return report;
}
