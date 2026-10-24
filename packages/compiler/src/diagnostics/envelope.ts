/* Machine-readable diagnostics: the versioned JSON envelope that
 * `scriptc coverage --print=diagnostics` and `scriptc build
 * --print=diagnostics` write to stdout, plus the location, category,
 * root-cause grouping and fallback-hint helpers the human coverage report
 * shares with it. One module owns all of them so the two views of the same
 * analysis cannot drift apart.
 *
 * Schema (version 1) — documented in docs/content/docs/coverage.mdx:
 *
 *   { schema: "scriptc-diagnostics", schemaVersion: 1, compilerVersion,
 *     command: "coverage" | "build", entry, success, phase, stats?,
 *     artifact?, groups: DiagnosticGroup[], diagnostics: LocatedDiagnostic[] }
 *
 * Additive changes (new optional fields, new categories or codes) keep the
 * version; renaming or removing a field, or changing a field's meaning,
 * bumps it. */
import { readFileSync } from "node:fs";
import type { ScrDiagnostic } from "./diagnostic.js";
import { isPerformanceCode } from "./dynamic-tier.js";
import type { WasmModuleReport } from "../wasm/discover.js";

export const DIAGNOSTICS_SCHEMA = "scriptc-diagnostics";
export const DIAGNOSTICS_SCHEMA_VERSION = 1;

/** What kind of problem a diagnostic reports, independent of its code band:
 *  - invalid-source: the program itself is wrong (TypeScript errors, bad JSON modules)
 *  - unsupported: valid TypeScript/JavaScript scriptc cannot compile yet
 *  - divergence: compiles, but the native program behaves differently from Node
 *  - performance: compiles and behaves as under Node, but runs slower than typed code would
 *  - environment: project configuration, scriptc's type world, toolchain or target
 *  - internal: a compiler bug */
export type DiagnosticCategory =
  | "invalid-source"
  | "unsupported"
  | "divergence"
  | "performance"
  | "environment"
  | "internal";

/** Where the diagnostic was found:
 *  - preflight: before lowering (type checking, configuration, module graph)
 *  - reached: code the entry path reaches (fails a build)
 *  - unreached: code nothing on the entry path reaches (cannot fail a build)
 *  - deferred: a JavaScript statement that compiles to a throw of this
 *    diagnostic when it executes */
export type DiagnosticScope = "preflight" | "reached" | "unreached" | "deferred";

export interface SourcePosition {
  file: string;
  /** 1-based line and UTF-16 column. */
  line: number;
  column: number;
}

export interface LocatedDiagnostic extends SourcePosition {
  code: string;
  category: DiagnosticCategory;
  severity: "error" | "warning";
  scope: DiagnosticScope;
  endLine: number;
  endColumn: number;
  /** 0-based UTF-16 offsets into the file. */
  start: number;
  end: number;
  message: string;
  /** Always present: the diagnostic's own hint, or the code family's. */
  hint: string;
  /** The id of the root-cause group this site belongs to. */
  group: string;
  /** Deferred scope only: the statement is module top-level code, so it
   * runs when its module loads. */
  startup?: true;
}

export interface DiagnosticGroup {
  id: string;
  code: string;
  category: DiagnosticCategory;
  severity: "error" | "warning";
  scope: DiagnosticScope;
  /** The message with per-instantiation type arguments collapsed. */
  message: string;
  hint: string;
  count: number;
  /** The first site in source order: the place to start fixing. */
  primary: SourcePosition;
  /** Every site in source order (primary included). */
  sites: SourcePosition[];
}

export interface TierUnitPosition extends SourcePosition {
  kind: "binding" | "field" | "function" | "class" | "module";
  name: string;
  owner?: string;
}

/** `scriptc coverage --explain-dynamic --print=diagnostics`: the tier
 * assignment of frontend/tier-analysis.ts with source positions. */
export interface TiersEnvelope {
  mode: "auto" | "static-only";
  statementsDynamic: number;
  dynamicFunctions: (SourcePosition & {
    name: string;
    operation: string;
    operationAt: SourcePosition;
    statements: number;
  })[];
  requests: (SourcePosition & {
    unit: TierUnitPosition;
    enclosing: TierUnitPosition;
    seed: string;
    scope: string;
    code: string;
    message: string;
  })[];
  units: (TierUnitPosition & { requests: number; sites: number })[];
}

export interface DiagnosticsEnvelope {
  schema: typeof DIAGNOSTICS_SCHEMA;
  schemaVersion: typeof DIAGNOSTICS_SCHEMA_VERSION;
  compilerVersion: string;
  command: "coverage" | "build";
  entry: string;
  /** coverage: no reached blockers (and, with --fail-on=divergences, no
   * divergences); build: an artifact was produced. */
  success: boolean;
  /** How far the command got: "preflight" when it stopped there,
   * "compile" when blockers remain, "native" when native code generation
   * or linking failed, "complete" otherwise. */
  phase: "preflight" | "compile" | "native" | "complete";
  stats?: {
    statementsTotal: number;
    statementsStatic: number;
    /** The compiled statements (counted in statementsStatic, which covers
     * every statement that compiles to native code) that belong to
     * dynamic-tier functions: code operating on values whose types are only
     * known at runtime. */
    statementsDynamic: number;
    statementsFailed: number;
    functionsSkipped: number;
    percentStatic: number;
  };
  /** build only: the produced artifact path. */
  artifact?: string;
  /** coverage --explain-dynamic only: the report-only tier assignment. */
  tiers?: TiersEnvelope;
  /** coverage only: the WebAssembly modules the build can see, with their
   * size, validity, proposals and the sources that found them. */
  wasmModules?: WasmModuleReport[];
  /** coverage only, when there is something to report: the packages and
   * user modules that would run in a Node island (report-only). */
  nodeIslands?: NodeIslandsEnvelope;
  groups: DiagnosticGroup[];
  diagnostics: LocatedDiagnostic[];
}

/** One reason a package is outside the native subset. */
export interface NodeIslandReasonEnvelope {
  class: string;
  /** R1.1–R2.5, or null for gap and packaging reasons. */
  rule: string | null;
  reason: string;
  code: string | null;
  message: string;
  source: string;
  at?: SourcePosition;
}

/** `scriptc coverage --print=diagnostics`: the Node island decisions. In
 * this version they are would-be decisions (mode "would-be"): the build
 * does not change. */
export interface NodeIslandsEnvelope {
  mode: "would-be";
  policy: "auto" | "explicit" | "off";
  /** Gap islands first, then by class and name. */
  islands: {
    package: string;
    version: string | null;
    path: string | null;
    class: string;
    reason: string;
    diagnostic: string | null;
    decision: string;
    evaluation: string;
    at?: SourcePosition;
    reasons: NodeIslandReasonEnvelope[];
    carries: string[];
    importedFrom: SourcePosition[];
  }[];
  userModules: { file: string; decision: string }[];
  /** Every npm package that is not an island: native, inside an island's
   * closure, or shared between native code and an island. */
  npmPackages: {
    package: string;
    version: string | null;
    path: string | null;
    status: string;
    islands: string[];
  }[];
  violations: (SourcePosition & { code: string; message: string })[];
  unknownPackages: string[];
}

/** The divergence band: compiles, but the program can behave differently
 * from Node. Warnings, never build failures. */
export function isDivergenceCode(code: string): boolean {
  return /^SC60\d{2}$/.test(code);
}

export function categoryOf(diag: ScrDiagnostic): DiagnosticCategory {
  const code = diag.code;
  if (isDivergenceCode(code)) return "divergence";
  if (isPerformanceCode(code)) return "performance";
  if (code === "SC0001") return diag.typeWorld === true ? "environment" : "invalid-source";
  if (code === "SC0003") return "invalid-source";
  if (code === "SC0002" || code === "SC0004") return "environment";
  if (/^SC[35]\d{3}$/.test(code)) return "environment";
  if (code === "SC8004" || code === "SC8005" || code === "SC8012") return "environment";
  if (/^SC9\d{3}$/.test(code)) return "internal";
  return "unsupported";
}

/** Code-family guidance for diagnostics whose construct site has no
 * specific hint: every group the report prints and every envelope entry
 * carries one. */
export function hintOf(diag: ScrDiagnostic): string {
  if (diag.hint !== undefined && diag.hint !== "") return diag.hint;
  const code = diag.code;
  if (code === "SC0001")
    return "fix the TypeScript error; scriptc only compiles programs that typecheck under its type world (strict null checks, the ES2025 library, Node types)";
  if (code === "SC1090")
    return "this form is valid TypeScript but does not compile yet — rewrite it with a supported equivalent of the construct the message names (https://scriptc.dev/limitations lists the boundary)";
  if (/^SC1\d{3}$/.test(code))
    return "this construct is valid TypeScript outside the compiled subset — rewrite it with a supported equivalent (https://scriptc.dev/limitations)";
  if (code === "SC2001")
    return "restate the value's type inside the compilable set (number, string, boolean, arrays, Maps, Sets, RegExp, functions, classes, records, unions of those, and 'unknown')";
  if (/^SC2\d{3}$/.test(code))
    return "restate the type inside the compilable set (https://scriptc.dev/limitations describes the boundary)";
  if (/^SC8\d{3}$/.test(code))
    return "see the Node island policy: npm code outside the native subset runs in Node, user code must be marked (scriptc coverage --explain-island=<package>)";
  if (/^SC9\d{3}$/.test(code))
    return "this is a compiler bug — please report it with the program that triggers it";
  return "see https://scriptc.dev/limitations";
}

/** The root-cause text of a message: type arguments of instantiated generic
 * types collapse to `<…>`, so every instantiation of one uncompilable
 * declaration lands in one group. Component fences (SC2009) group on the
 * named component alone — the outer container type repeats per use. */
export function rootCauseMessage(diag: ScrDiagnostic): string {
  let text = diag.message.replace(/ (?:is|are) not supported yet$/, "");
  if (diag.code === "SC2009") {
    const at = text.indexOf("cannot be compiled: ");
    if (at >= 0) text = text.slice(at + "cannot be compiled: ".length);
  }
  return collapseTypeArguments(text);
}

function collapseTypeArguments(text: string): string {
  // Only inside quoted spans: `<` elsewhere is prose (or an operator name).
  return text.replace(/'[^']*'/g, (quoted) => {
    let inner = quoted;
    for (let i = 0; i < 8; i++) {
      const next = inner.replace(/(\w)<[^<>]*>/g, "$1<…>");
      if (next === inner) break;
      inner = next;
    }
    return inner;
  });
}

export function groupId(diag: ScrDiagnostic, scope: DiagnosticScope): string {
  // A short stable id: FNV-1a over code, scope and root-cause text.
  const key = `${diag.code}\0${scope}\0${rootCauseMessage(diag)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${diag.code}-${h.toString(16).padStart(8, "0")}`;
}

/** Offset → line/column over a source text, with the line table cached
 * per file. Files missing from the analysis' sources are read from disk;
 * a file that cannot be read reports line 1 with the raw offset as column. */
export class SourceLocator {
  private readonly lineStarts = new Map<string, number[] | null>();

  constructor(private readonly sources: ReadonlyMap<string, string> = new Map()) {}

  private starts(file: string): number[] | null {
    let starts = this.lineStarts.get(file);
    if (starts !== undefined) return starts;
    let text = this.sources.get(file);
    if (text === undefined) {
      try {
        text = readFileSync(file, "utf8");
      } catch {
        text = undefined;
      }
    }
    if (text === undefined) {
      starts = null;
    } else {
      starts = [0];
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    }
    this.lineStarts.set(file, starts);
    return starts;
  }

  position(file: string, offset: number): { line: number; column: number } {
    const starts = this.starts(file);
    if (starts === null) return { line: 1, column: offset + 1 };
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo]! + 1 };
  }
}

export function locateDiagnostic(
  diag: ScrDiagnostic,
  scope: DiagnosticScope,
  locator: SourceLocator,
): LocatedDiagnostic {
  const start = locator.position(diag.loc.file, diag.loc.start);
  const end = locator.position(diag.loc.file, diag.loc.end);
  return {
    code: diag.code,
    category: categoryOf(diag),
    severity:
      isDivergenceCode(diag.code) || isPerformanceCode(diag.code) || diag.code === "SC8004"
        ? "warning"
        : "error",
    scope,
    file: diag.loc.file,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
    start: diag.loc.start,
    end: diag.loc.end,
    message: diag.message,
    hint: hintOf(diag),
    group: groupId(diag, scope),
    ...(scope === "deferred" && diag.startup === true ? { startup: true as const } : {}),
  };
}

/** Root-cause groups over located diagnostics, in input order of first
 * appearance; sites inside each group are in source order. */
export function groupDiagnostics(
  diags: readonly ScrDiagnostic[],
  scope: DiagnosticScope,
  locator: SourceLocator,
): { located: LocatedDiagnostic[]; groups: DiagnosticGroup[] } {
  const located: LocatedDiagnostic[] = [];
  const groups = new Map<string, DiagnosticGroup>();
  for (const diag of diags) {
    const l = locateDiagnostic(diag, scope, locator);
    located.push(l);
    const site = { file: l.file, line: l.line, column: l.column };
    const existing = groups.get(l.group);
    if (existing) {
      existing.count++;
      existing.sites.push(site);
      // A group whose sites disagree on the hint keeps the first specific one.
    } else {
      groups.set(l.group, {
        id: l.group,
        code: l.code,
        category: l.category,
        severity: l.severity,
        scope,
        message: rootCauseMessage(diag),
        hint: l.hint,
        count: 1,
        primary: site,
        sites: [site],
      });
    }
  }
  for (const g of groups.values()) {
    g.sites.sort(comparePositions);
    // Identical positions (one construct reported through two paths) count
    // once as a site but keep their diagnostic count.
    g.sites = g.sites.filter((s, i) => i === 0 || comparePositions(s, g.sites[i - 1]!) !== 0);
    g.primary = g.sites[0]!;
  }
  return { located, groups: [...groups.values()] };
}

export function comparePositions(a: SourcePosition, b: SourcePosition): number {
  return a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column;
}

/** The versioned machine-readable form of a build's outcome
 * (`scriptc build --print=diagnostics`). Build diagnostics are all reached
 * (or preflight) errors; divergence warnings ride along on success. */
export function buildEnvelope(opts: {
  compilerVersion: string;
  entry: string;
  ok: boolean;
  artifact?: string;
  diagnostics: readonly ScrDiagnostic[];
  warnings?: readonly ScrDiagnostic[];
  sourceTexts?: ReadonlyMap<string, string>;
}): DiagnosticsEnvelope {
  const locator = new SourceLocator(opts.sourceTexts);
  const located: LocatedDiagnostic[] = [];
  const groups: DiagnosticGroup[] = [];
  const preflight = opts.diagnostics.filter((d) => /^SC0\d{3}$/.test(d.code));
  const backend = opts.diagnostics.filter((d) => /^SC[35]\d{3}$/.test(d.code));
  const add = (diags: readonly ScrDiagnostic[], scope: DiagnosticScope) => {
    if (diags.length === 0) return;
    const r = groupDiagnostics(diags, scope, locator);
    located.push(...r.located);
    groups.push(...r.groups);
  };
  add(preflight, "preflight");
  add(
    opts.diagnostics.filter((d) => !preflight.includes(d)),
    "reached",
  );
  add(opts.warnings ?? [], "reached");
  return {
    schema: DIAGNOSTICS_SCHEMA,
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    compilerVersion: opts.compilerVersion,
    command: "build",
    entry: opts.entry,
    success: opts.ok,
    phase: opts.ok
      ? "complete"
      : preflight.length > 0
        ? "preflight"
        : backend.length > 0 && backend.length === opts.diagnostics.length
          ? "native"
          : "compile",
    ...(opts.artifact === undefined ? {} : { artifact: opts.artifact }),
    groups,
    diagnostics: located,
  };
}
