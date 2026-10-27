/* The static coverage report — the product's thesis rendered as text.
 *
 * Reframes "does my program compile?" (binary, frustrating) into "how static
 * is my program?" (a gradient you can improve): how many statements lowered
 * to native code and what exactly blocked the rest, blockers grouped by
 * code and ordered by impact. Built entirely from what the lowerer already
 * collects — the diagnostics registry is the coverage taxonomy.
 */
import type { Milestone, ScrDiagnostic } from "../diagnostics/diagnostic.js";
import {
  DIAGNOSTICS_SCHEMA,
  DIAGNOSTICS_SCHEMA_VERSION,
  SourceLocator,
  groupDiagnostics,
  type DiagnosticGroup,
  type DiagnosticScope,
  type DiagnosticsEnvelope,
  type LocatedDiagnostic,
  type SourcePosition,
  type NodeIslandsEnvelope,
  type TierUnitPosition,
  type TiersEnvelope,
} from "../diagnostics/envelope.js";
import { renderDiagnostics } from "../diagnostics/render.js";
import {
  dynamicSlotLabel,
  isDynamicSlotCode,
  type DynamicSlotEntry,
} from "../diagnostics/dynamic-slots.js";
import type { LowerStats } from "../frontend/lowering/lowerer.js";
import type { ProvenanceSources } from "../frontend/provenance-registry.js";
import type {
  DemotionUnit,
  LocalizedFailureReport,
  TierReport,
} from "../frontend/tier-analysis.js";
import type { WasmModuleReport } from "../wasm/discover.js";
import {
  describe as describeReason,
  hasNodeIslandDecisions,
  type NodeIslandEntry,
  type NodeIslandReport,
} from "../node-islands/summary.js";
import { classDescription } from "../node-islands/rules.js";
import type { SrcLoc } from "../ir/ir.js";

export interface CoverageInput {
  file: string;
  stats: LowerStats;
  diagnostics: ScrDiagnostic[];
  /** JS statements whose compile fences deferred to RUNTIME (runtimeFence
   * statements): the program builds, but executing one throws — the
   * report lists them so nothing hides. */
  runtimeFences?: ScrDiagnostic[];
  /** The unreached remainder: bodies nothing on the entry path reaches,
   * lowered in a throwaway analysis pass. Its blockers cannot fail a
   * build — the report shows them as a secondary, dimmed group. */
  unreached?: { stats: LowerStats; diagnostics: ScrDiagnostic[]; runtimeFences?: ScrDiagnostic[] };
  /** Compile-time-detectable behavior differences from Node (SC6xxx):
   * the program compiles, but these sites can behave differently natively.
   * Never blockers; `--fail-on=divergences` opts into failing on them. */
  divergences?: ScrDiagnostic[];
  /** The performance warning (SC6101): likely-hot functions the source
   * leaves untyped. Never blockers; `--fail-on=dynamic` opts into failing
   * on it. */
  performance?: ScrDiagnostic[];
  /** Localized failure: the checked dynamic slots (SC6104, also in
   * `performance`). `--fail-on=dynamic-slots` fails on them. */
  dynamicSlots?: DynamicSlotEntry[];
  /** Each dependency's native compilation outcome, with the first refusal
   * reason for a refused package. */
  npmStatic?: NpmStaticStatus[];
  /** --provenance-sources: the resolved source-mapped packages and the
   * fallback notes — the report renders per-package attribution from
   * statsByFile (statements inside each package's source dir). */
  provenance?: ProvenanceSources;
  /** --provenance-sources: per-file statement attribution from the emit
   * pass (LowerResult.statsByFile). */
  statsByFile?: Map<string, { total: number; failed: number }>;
  /** --provenance-sources: diagnostics of elided pure-annotated dead
   * consts (off the build; the provenance section names them). */
  provenanceElided?: ScrDiagnostic[];
  /** --explain-dynamic: the report-only tier assignment (which bindings,
   * fields, functions, classes and modules the dynamic tier would take). */
  tiers?: TierReport;
  /** The WebAssembly modules the build can see (wasm/discover.ts): their
   * size, validity and the proposals they use. */
  wasmModules?: WasmModuleReport[];
  /** Node islands, report-only: the packages and user modules that would
   * run in a Node island, and why. Present when there is something to
   * report. */
  nodeIslands?: NodeIslandReport;
  /** True when tsc preflight failed — no coverage can be computed. */
  preflightFailed: boolean;
}

/** One dependency's native compilation outcome. */
export interface NpmStaticStatus {
  package: string;
  status: "static" | "refused";
  /** The first refusal reason for a refused package. */
  detail?: string;
  /** How to act on the refusal, when there is a specific remedy. */
  hint?: string;
}

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const MILESTONE_ORDER: Milestone[] = ["M1", "M2", "M3", "M4", "M5", "later"];

/** Human rows cap their message: long embedded type text would otherwise
 * push lines past several hundred columns. The full message is in the
 * --print=diagnostics envelope (and in `scriptc build` output). */
const MESSAGE_CAP = 200;
/** Sites listed per group before "+N more". */
const SITES_SHOWN = 3;

interface Blocker {
  code: string;
  /** Root-cause message (per-instantiation type arguments collapsed). */
  what: string;
  milestone: Milestone | undefined;
  count: number;
  group: DiagnosticGroup;
}

export interface CoverageRenderOptions {
  color?: boolean;
  sourceTexts?: Map<string, string>;
  /** Paths under this directory render relative to it. */
  root?: string;
}

export function renderCoverage(input: CoverageInput, opts: CoverageRenderOptions = {}): string {
  const c = (code: string, s: string) => (opts.color ? code + s + RESET : s);
  const out: string[] = [];
  const locator = new SourceLocator(opts.sourceTexts);
  const groupBlockers = (diags: ScrDiagnostic[], scope: DiagnosticScope = "reached") =>
    groupBlockersAt(diags, scope, locator);
  const where = (p: SourcePosition) => `${displayPath(p.file, opts.root)}:${p.line}:${p.column}`;
  // One root-cause group: count, code and message, then where it occurs
  // (first sites in source order) and what to do about it.
  const renderRows = (group: Blocker[], tone: string, dim = false) => {
    for (const b of group) {
      const what = capMessage(b.what);
      out.push(
        `    ${c(dim ? DIM : tone, `×${b.count}`.padStart(4))}  ${c(DIM, b.code)}  ${dim ? c(DIM, what) : what}`,
      );
      const sites = b.group.sites;
      const shown = sites.slice(0, SITES_SHOWN).map(where).join(", ");
      const more = sites.length > SITES_SHOWN ? ` (+${sites.length - SITES_SHOWN} more)` : "";
      out.push(`          ${c(DIM, `at ${shown}${more}`)}`);
      out.push(`          ${c(DIM, `hint: ${b.group.hint}`)}`);
    }
  };
  out.push(`${c(BOLD, "scriptc coverage")} ${DIMPath(input.file, opts.color ?? false)}`);
  out.push("");

  if (input.preflightFailed) {
    // Three preflight failure shapes, in order of "whose problem is it":
    // an incompatible project config (SC0002 — ours to explain), real
    // TypeScript errors (theirs to fix), and OUR import-form fences
    // (SC1xxx from checkPreflight — lowering-style blockers that shape
    // the module graph, reported as blockers instead of masquerading as
    // "TypeScript errors").
    const config = input.diagnostics.filter((d) => d.code === "SC0002");
    if (config.length > 0) {
      out.push(`  ${c(RED, "not analyzable")}: ${config[0]!.message}`);
      return out.join("\n");
    }
    const projectConfig = input.diagnostics.filter((d) => d.code === "SC8004");
    if (projectConfig.length > 0) {
      out.push(
        `  ${c(RED, "not analyzable")}: the project's scriptc configuration has ${projectConfig.length} unknown setting${projectConfig.length === 1 ? "" : "s"}`,
      );
      for (const d of projectConfig) {
        const p = locator.position(d.loc.file, d.loc.start);
        out.push(`    ${c(DIM, "SC8004")}  ${d.message}`);
        out.push(`          ${c(DIM, `at ${where({ file: d.loc.file, ...p })}`)}`);
        if (d.hint !== undefined) out.push(`          ${c(DIM, `hint: ${d.hint}`)}`);
      }
      return out.join("\n");
    }
    const tsc = input.diagnostics.filter((d) => d.code === "SC0001");
    if (tsc.length > 0) {
      const world = tsc.filter((d) => d.typeWorld === true).length;
      out.push(
        `  ${c(RED, "not analyzable")}: ${tsc.length} TypeScript error${tsc.length === 1 ? "" : "s"} — ` +
          `fix type errors first (scriptc only analyzes programs that typecheck)`,
      );
      if (world > 0) {
        out.push(
          `  ${c(YELLOW, "note")}: ${world === tsc.length ? (world === 1 ? "this error comes" : "these errors come") : `${world} of them come`} from scriptc's type world, ` +
            `not necessarily from the project's own tsc configuration — see each hint`,
        );
      }
      // The same rendered diagnostics a build prints: coverage is the
      // command people reach for first, so the verdict line alone would
      // swallow the code frames that say what to fix.
      if (opts.sourceTexts) {
        out.push("");
        out.push(renderDiagnostics(tsc, opts.sourceTexts, { color: opts.color ?? false }));
      }
      return out.join("\n");
    }
    const n = input.diagnostics.length;
    out.push(
      `  ${c(RED, "analysis stopped at preflight")}: ${n} unsupported import site${n === 1 ? "" : "s"} — ` +
        `the module graph must load before statements can be counted`,
    );
    renderRows(groupBlockers(input.diagnostics, "preflight"), RED);
    if (opts.sourceTexts) {
      out.push("");
      out.push(
        renderDiagnostics(input.diagnostics, opts.sourceTexts, { color: opts.color ?? false }),
      );
    }
    return out.join("\n");
  }

  // Whole-program totals include reached and unreached statements.
  const un = input.unreached;
  const total = input.stats.statementsTotal + (un?.stats.statementsTotal ?? 0);
  const failed = input.stats.statementsFailed + (un?.stats.statementsFailed ?? 0);
  const skipped = input.stats.functionsSkipped + (un?.stats.functionsSkipped ?? 0);
  const ok = total - failed;
  const pct = total === 0 ? 100 : Math.floor((ok / total) * 100);
  const pctColor = pct === 100 ? GREEN : pct >= 75 ? YELLOW : RED;

  out.push(`  statements analyzed   ${total}`);
  out.push(`  compile statically    ${ok}  ${c(pctColor, c(BOLD, `(${pct}%)`))}`);
  const dynamic = dynamicStatements(input);
  if (dynamic > 0) {
    out.push(
      `    in dynamic tier     ${dynamic}  ${c(DIM, "(operate on values typed only at runtime; --explain-dynamic lists them)")}`,
    );
  }

  if (skipped > 0) {
    out.push(
      `  ${c(DIM, `(${skipped} function${skipped === 1 ? "" : "s"} not analyzed — signature blocked; their statements count as not static)`)}`,
    );
  }
  renderDynamicSlots(input.dynamicSlots ?? [], out, c, (loc) => {
    const p = locator.position(loc.file, loc.start);
    return `${displayPath(loc.file, opts.root)}:${p.line}:${p.column}`;
  });
  out.push("");

  // Report native package compilation and the first reason for each refusal.
  const npmStatic = input.npmStatic ?? [];
  if (npmStatic.length > 0) {
    out.push(`  ${c(DIM, "npm package compilation:")}`);
    const widestP = Math.max(...npmStatic.map((s) => s.package.length));
    for (const s of npmStatic) {
      const status =
        s.status === "static"
          ? c(GREEN, "static")
          : c(RED, "refused") + (s.detail !== undefined ? ` ${c(DIM, `(${s.detail})`)}` : "");
      out.push(`    ${s.package.padEnd(widestP)}  ${status}`);
    }
    out.push("");
  }

  // Node islands (report-only): what would run in Node, gap islands
  // first (DESIGN.md §1.3: a gap island is compiler work an island hides).
  if (input.nodeIslands !== undefined && hasNodeIslandDecisions(input.nodeIslands)) {
    renderNodeIslands(
      input.nodeIslands,
      out,
      c,
      (loc) => {
        const p = locator.position(loc.file, loc.start);
        return where({ file: loc.file, ...p });
      },
      opts.root,
    );
    out.push("");
  }

  // The WebAssembly modules the build can see (wasm/discover.ts). A build
  // translates the valid ones to native code (wasm/translate.ts) when the
  // program uses the WebAssembly API; the others fail to load at run time.
  const wasm = input.wasmModules ?? [];
  if (wasm.length > 0) {
    out.push(
      `  ${c(DIM, "WebAssembly modules:")} ${c(DIM, "(found at build time; valid ones compile to native code)")}`,
    );
    for (const m of wasm) {
      const name = m.path !== undefined ? displayPath(m.path, opts.root) : "inline module";
      const state =
        m.status === "valid"
          ? c(GREEN, "valid")
          : m.status === "unsupported"
            ? c(YELLOW, `uses ${m.unsupported.join(", ")}`)
            : c(RED, `${m.status}: ${m.error ?? ""}`);
      out.push(`    ${name}  ${c(DIM, `${groupDigits(m.size)} bytes`)}  ${state}`);
      const imports = m.importModules.length > 0 ? ` (${m.importModules.join(", ")})` : "";
      out.push(
        `      ${c(DIM, `${counted(m.functions, "function")}, ${counted(m.imports, "import")}${imports}, ${counted(m.exports, "export")}`)}`,
      );
      if (m.features.length > 0) out.push(`      ${c(DIM, `features: ${m.features.join(", ")}`)}`);
      const shown = m.sources.slice(0, SITES_SHOWN);
      for (const s of shown) {
        const at =
          s.line !== undefined
            ? `${displayPath(s.file, opts.root)}:${s.line}`
            : displayPath(s.file, opts.root);
        const how =
          s.kind === "path"
            ? `path at ${at}`
            : s.kind === "inline"
              ? `inline at ${at}`
              : s.kind === "package"
                ? `shipped by the package at ${displayPath(dirOf(s.file), opts.root)}`
                : `configured by ${at}`;
        out.push(`      ${c(DIM, `found: ${how}`)}`);
      }
      if (m.sources.length > shown.length) {
        out.push(`      ${c(DIM, `found: +${m.sources.length - shown.length} more`)}`);
      }
    }
    out.push("");
  }

  // --provenance-sources: per-package attribution — the answer to "did
  // the DEPENDENCY's statements compile static?", computed by summing
  // statsByFile entries under each package's source dir. Elided
  // pure-annotated dead consts and fallback notes render here too, so
  // the provenance story is complete in one place.
  if (input.provenance !== undefined) {
    const prov = input.provenance;
    out.push(
      `  ${c(BOLD, "provenance sources")}   ${c(DIM, "(attested source compiled as program modules)")}`,
    );
    for (const pkg of prov.packages) {
      let pTotal = 0;
      let pFailed = 0;
      const dir = pkg.dir.endsWith("/") ? pkg.dir : `${pkg.dir}/`;
      for (const [file, s] of input.statsByFile ??
        new Map<string, { total: number; failed: number }>()) {
        if (!file.startsWith(dir)) continue;
        pTotal += s.total;
        pFailed += s.failed;
      }
      const elided = (input.provenanceElided ?? []).filter((d) =>
        d.loc.file.startsWith(dir),
      ).length;
      const pOk = pTotal - pFailed;
      const pPct = pTotal === 0 ? 100 : Math.floor((pOk / pTotal) * 100);
      const pColor = pPct === 100 ? GREEN : pPct >= 75 ? YELLOW : RED;
      const shortRepo = pkg.repo
        .replace(/^git\+/, "")
        .replace(/^https:\/\//, "")
        .replace(/@refs\/.*$/, "");
      out.push(
        `    ${pkg.name}@${pkg.version}  ${c(DIM, `${shortRepo} @ ${pkg.commit.slice(0, 12)}`)}`,
      );
      out.push(
        `      ${pTotal} statements: ${pOk} static ${c(pColor, c(BOLD, `(${pPct}%)`))}, ${pFailed} fenced` +
          (elided > 0
            ? ` ${c(DIM, `(${elided} fence${elided === 1 ? "" : "s"} elided as @__PURE__ dead consts — uses would fence per site)`)}`
            : ""),
      );
    }
    for (const note of prov.notes) out.push(`    ${c(YELLOW, "note")}  ${note}`);
    out.push("");
  }

  // JS statements whose fences DEFERRED to runtime (the runtimeFence
  // statements the module carries): they compile, but executing one
  // throws its SC-coded error — the report lists them so a "compiling"
  // JS program never hides its dynamic gaps.
  // Fences in a module's top-level code run when the module initializes:
  // they are listed first, as sites that run at startup.
  const fences = input.runtimeFences ?? [];
  const startup = fences.filter((d) => d.startup === true);
  const later = fences.filter((d) => d.startup !== true);
  if (startup.length > 0) {
    out.push(
      `  ${c(YELLOW, "runs at startup")}   ${startup.length} site${startup.length === 1 ? "" : "s"} ${c(DIM, "(JS statements in module top-level code, which runs when the module loads)")}`,
    );
    renderRows(groupBlockers(startup, "deferred"), YELLOW);
    out.push("");
  }
  if (later.length > 0) {
    out.push(
      `  ${c(YELLOW, "deferred to runtime")}   ${later.length} site${later.length === 1 ? "" : "s"} ${c(DIM, "(JS statements that throw their fence if executed)")}`,
    );
    renderRows(groupBlockers(later, "deferred"), YELLOW);
    out.push("");
  }

  // Divergences: the program compiles, but these sites can behave
  // differently from Node. Never blockers (--fail-on=divergences opts in).
  const divergences = input.divergences ?? [];
  const renderDivergences = () => {
    if (divergences.length === 0) return;
    out.push(
      `  ${c(YELLOW, "differs from Node")}   ${divergences.length} site${divergences.length === 1 ? "" : "s"} ${c(DIM, "(compiles; the native program can behave differently)")}`,
    );
    renderRows(groupBlockers(divergences), YELLOW);
  };
  // The performance warning: its message names the functions.
  const performance = (input.performance ?? []).filter((d) => !isDynamicSlotCode(d.code));
  const renderPerformance = () => {
    for (const d of performance) {
      out.push("");
      const [head, ...rest] = d.message.split("\n");
      out.push(`  ${c(YELLOW, "untyped and likely hot")}   ${head}`);
      for (const line of rest) out.push(`  ${line}`);
      if (d.hint !== undefined) out.push(`    ${c(DIM, `hint: ${d.hint}`)}`);
    }
  };

  const unreachedDiags = [...(un?.diagnostics ?? []), ...(un?.runtimeFences ?? [])];
  if (failed === 0 && input.diagnostics.length === 0 && unreachedDiags.length === 0) {
    out.push(`  ${c(GREEN, "fully static")} — all analyzed statements compile to native code.`);
    if (divergences.length > 0) {
      out.push("");
      renderDivergences();
    }
    renderPerformance();
    return out.join("\n");
  }

  // Ordered by internal scheduling (soonest first), then by frequency —
  // the top line is the blocker most likely to disappear next. The
  // milestone labels themselves are maintainer business and never rendered.

  const blockers = groupBlockers(input.diagnostics);
  const unreachedBlockers = groupBlockers(unreachedDiags, "unreached");
  const rejected = blockers;
  const renderGroup = (group: Blocker[], dim = false) => renderRows(group, RED, dim);
  if (
    failed > 0 &&
    blockers.length === 0 &&
    unreachedBlockers.length === 0 &&
    fences.length === 0
  ) {
    // Every failed statement must be explained; reaching this is a
    // compiler bug, reported instead of omitted.
    out.push(
      `  ${c(RED, "blockers:")} ${failed} statement${failed === 1 ? "" : "s"} failed without a diagnostic (a compiler bug — please report it)`,
    );
  }
  if (rejected.length > 0) {
    out.push(`  blockers:`);
    renderGroup(rejected);
  }
  // Blockers in code nothing on the entry path reaches: never lowered by
  // a build, so they cannot fail one — secondary by design.
  if (unreachedBlockers.length > 0) {
    if (rejected.length > 0) out.push("");
    out.push(
      `  ${c(DIM, "in unreached code")}   ${c(DIM, "(never lowered — cannot fail a build)")}`,
    );
    renderGroup(unreachedBlockers, true);
  }
  if (divergences.length > 0) {
    out.push("");
    renderDivergences();
  }
  renderPerformance();
  return out.join("\n");
}

/** "1 function", "1,698 functions". */
function counted(n: number, noun: string): string {
  return `${groupDigits(n)} ${noun}${n === 1 ? "" : "s"}`;
}

/** 637405 → "637,405". */
function groupDigits(n: number): string {
  const digits = String(n);
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

function dirOf(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash <= 0 ? file : file.slice(0, slash);
}

function DIMPath(file: string, color: boolean): string {
  return color ? DIM + file + RESET : file;
}

function groupBlockersAt(
  diags: ScrDiagnostic[],
  scope: DiagnosticScope,
  locator: SourceLocator,
): Blocker[] {
  const { located, groups } = groupDiagnostics(diags, scope, locator);
  // A group's schedule is its first diagnostic's (one root cause, one
  // milestone).
  const milestone = new Map<string, Milestone | undefined>();
  diags.forEach((d, i) => {
    const id = located[i]!.group;
    if (!milestone.has(id)) milestone.set(id, d.milestone);
  });
  const rank = (m: Milestone | undefined) =>
    m === undefined ? MILESTONE_ORDER.length : MILESTONE_ORDER.indexOf(m);
  return groups
    .map((g) => ({
      code: g.code,
      what: g.message,
      milestone: milestone.get(g.id),
      count: g.count,
      group: g,
    }))
    .sort(
      (a, b) =>
        rank(a.milestone) - rank(b.milestone) || b.count - a.count || a.code.localeCompare(b.code),
    );
}

function capMessage(text: string): string {
  return text.length <= MESSAGE_CAP ? text : `${text.slice(0, MESSAGE_CAP - 1)}…`;
}

function displayPath(file: string, root: string | undefined): string {
  if (root === undefined || root === "") return file;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

/** What `coverage --fail-on` checks: reached blockers (they fail a build)
 * and, optionally, divergences, the performance warning or Node islands.
 * Unreached blockers never fail. */
export type CoverageFailOn =
  | "blockers"
  | "divergences"
  | "dynamic"
  | "dynamic-slots"
  | "node-islands"
  | "eager-node-islands"
  | "island-gaps";

export const COVERAGE_FAIL_ON: readonly CoverageFailOn[] = [
  "blockers",
  "divergences",
  "dynamic",
  "dynamic-slots",
  "node-islands",
  "eager-node-islands",
  "island-gaps",
];

/** Whether the analysis passes the selected gate. Preflight failures
 * always fail; `failOn` undefined means only preflight fails (the report's
 * historical contract). Divergence gating implies blocker gating. */
export function coveragePasses(input: CoverageInput, failOn?: CoverageFailOn): boolean {
  if (input.preflightFailed) return false;
  if (failOn === undefined) return true;
  // Reached blockers are exactly the diagnostics a build would fail on;
  // runtime fences build (the statement throws only if it executes).
  if (input.diagnostics.length > 0) return false;
  if (failOn === "divergences" && (input.divergences?.length ?? 0) > 0) return false;
  if (failOn === "dynamic" && (input.performance ?? []).some((d) => !isDynamicSlotCode(d.code)))
    return false;
  if (failOn === "dynamic-slots" && (input.dynamicSlots?.length ?? 0) > 0) return false;
  // The Node island gates (report-only islands count: they are what a
  // build would choose). Every island evaluates eagerly until deferred
  // evaluation lands, so eager-node-islands equals node-islands for now.
  // Would-be policy errors (SC8002, SC8003) fail every island gate.
  const islands = input.nodeIslands;
  if (islands === undefined) return true;
  const anyIsland = failOn === "node-islands" || failOn === "eager-node-islands";
  if ((anyIsland || failOn === "island-gaps") && islands.violations.length > 0) return false;
  if (anyIsland && (islands.islands.length > 0 || islands.userModules.length > 0)) return false;
  if (failOn === "island-gaps" && islands.islands.some((i) => i.class === "gap")) return false;
  return true;
}

/** The versioned machine-readable form of a coverage analysis
 * (`scriptc coverage --print=diagnostics`). */
export function coverageEnvelope(
  input: CoverageInput,
  opts: {
    compilerVersion: string;
    sourceTexts?: Map<string, string>;
    failOn?: CoverageFailOn;
  },
): DiagnosticsEnvelope {
  const locator = new SourceLocator(opts.sourceTexts);
  const located: LocatedDiagnostic[] = [];
  const groups: DiagnosticGroup[] = [];
  const add = (diags: readonly ScrDiagnostic[] | undefined, scope: DiagnosticScope) => {
    if (diags === undefined || diags.length === 0) return;
    const r = groupDiagnostics(diags, scope, locator);
    located.push(...r.located);
    groups.push(...r.groups);
  };
  if (input.preflightFailed) {
    add(input.diagnostics, "preflight");
  } else {
    add(input.diagnostics, "reached");
    add(input.runtimeFences, "deferred");
    add(input.unreached?.diagnostics, "unreached");
    add(input.unreached?.runtimeFences, "deferred");
    add(input.divergences, "reached");
    add(input.performance, "reached");
  }
  const un = input.unreached;
  const total = input.stats.statementsTotal + (un?.stats.statementsTotal ?? 0);
  const failed = input.stats.statementsFailed + (un?.stats.statementsFailed ?? 0);
  const skipped = input.stats.functionsSkipped + (un?.stats.functionsSkipped ?? 0);
  const ok = total - failed;
  return {
    schema: DIAGNOSTICS_SCHEMA,
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    compilerVersion: opts.compilerVersion,
    command: "coverage",
    entry: input.file,
    success: coveragePasses(input, opts.failOn ?? "blockers"),
    phase: input.preflightFailed
      ? "preflight"
      : input.diagnostics.length > 0
        ? "compile"
        : "complete",
    ...(input.preflightFailed
      ? {}
      : {
          stats: {
            statementsTotal: total,
            statementsStatic: ok,
            statementsDynamic: dynamicStatements(input),
            statementsFailed: failed,
            functionsSkipped: skipped,
            percentStatic: total === 0 ? 100 : Math.floor((ok / total) * 100),
          },
        }),
    ...(input.dynamicSlots !== undefined
      ? {
          dynamicSlots: input.dynamicSlots.map((slot) => ({
            file: slot.loc.file,
            ...locator.position(slot.loc.file, slot.loc.start),
            name: slot.name,
            kind: slot.slot,
            declaredType: slot.declaredType,
            code: slot.code,
            reason: slot.reason,
            ...(slot.partial === true ? { partial: true } : {}),
            dynamicOps: slot.operations ?? 0,
          })),
        }
      : {}),
    ...(input.tiers !== undefined ? { tiers: tiersEnvelope(input.tiers, locator) } : {}),
    ...(input.wasmModules !== undefined ? { wasmModules: input.wasmModules } : {}),
    ...(input.nodeIslands !== undefined
      ? { nodeIslands: nodeIslandsEnvelope(input.nodeIslands, locator) }
      : {}),
    groups,
    diagnostics: located,
  };
}

/** Reached statements in dynamic-tier functions, never more than the
 * compiled statements they are part of. */
function dynamicStatements(input: CoverageInput): number {
  const compiled = input.stats.statementsTotal - input.stats.statementsFailed;
  return Math.max(0, Math.min(input.stats.statementsDynamic ?? 0, compiled));
}

function tiersEnvelope(tiers: TierReport, locator: SourceLocator): TiersEnvelope {
  const at = (loc: { file: string; start: number }): SourcePosition => ({
    file: loc.file,
    ...locator.position(loc.file, loc.start),
  });
  const unit = (u: DemotionUnit): TierUnitPosition => ({
    kind: u.kind,
    name: u.name,
    ...(u.owner !== undefined ? { owner: u.owner } : {}),
    ...at(u.loc),
  });
  return {
    mode: tiers.mode,
    statementsDynamic: tiers.statementsDynamic,
    dynamicFunctions: tiers.dynamicFunctions.map((fn) => ({
      name: fn.name,
      ...at(fn.loc),
      operation: fn.operation,
      operationAt: at(fn.operationLoc),
      statements: fn.statements,
    })),
    requests: tiers.requests.map((r) => ({
      unit: unit(r.unit),
      enclosing: unit(r.enclosing),
      seed: r.seed,
      scope: r.scope,
      code: r.code,
      message: r.message,
      ...at(r.loc),
    })),
    units: tiers.units.map((u) => ({ ...unit(u), requests: u.requests, sites: u.sites })),
    localizedFailure: {
      errors: tiers.localizedFailure.errors,
      typeFailures: tiers.localizedFailure.typeFailures,
      cascades: tiers.localizedFailure.cascades,
      clearedThroughL2: tiers.localizedFailure.clearedThroughL2,
      clearedThroughL4: tiers.localizedFailure.clearedThroughL4,
      remainingByCode: tiers.localizedFailure.remainingByCode,
      slots: tiers.localizedFailure.slots.map((slot) => ({
        ...at(slot.loc),
        slot: slot.slot,
        name: slot.name,
        declaredType: slot.declaredType,
        family: slot.family,
        code: slot.code,
        message: slot.message,
        stage: slot.stage,
        ...(slot.rejects !== null ? { rejects: slot.rejects } : {}),
        cascade: slot.cascade,
      })),
    },
  };
}

/** IR function names as a user reads them: `%init.3` is a module's top
 * level, `%Point.norm` the method `Point.norm`; generated helpers keep
 * their `%`-prefixed names. */
function functionDisplayName(name: string): string {
  if (name.startsWith("%init.")) return "<top level>";
  if (/^%[A-Za-z_$][\w$]*\.[A-Za-z_$#][\w$]*$/.test(name)) return name.slice(1);
  return name;
}

function unitLabel(u: DemotionUnit, root: string | undefined): string {
  if (u.kind === "module") return `module ${displayPath(u.name, root)}`;
  if (u.kind === "binding" && u.owner !== undefined) return `binding ${u.name} in ${u.owner}`;
  return `${u.kind} ${u.name}`;
}

function unitMatches(u: DemotionUnit, query: string): boolean {
  return (
    u.name === query ||
    u.name.endsWith(`.${query}`) ||
    u.name.split(" ")[0] === query ||
    `${u.owner ?? ""}:${u.name}` === query
  );
}

const DYNAMIC_SLOTS_SHOWN = 20;

/** The dynamic slots under the statement counts: each slot's declared
 * type, and why it has no static lowering. */
function renderDynamicSlots(
  slots: readonly DynamicSlotEntry[],
  out: string[],
  c: (code: string, s: string) => string,
  where: (loc: SrcLoc) => string,
): void {
  if (slots.length === 0) return;
  out.push(
    `    dynamic slots       ${slots.length}  ${c(DIM, "(declared types with no static lowering, held as checked-dynamic values; SC6104)")}`,
  );
  // The costly slots first: most dynamic operations, then source order.
  const ranked = slots
    .map((slot, index) => ({ slot, index }))
    .sort((a, b) => (b.slot.operations ?? 0) - (a.slot.operations ?? 0) || a.index - b.index)
    .map(({ slot }) => slot);
  for (const slot of ranked.slice(0, DYNAMIC_SLOTS_SHOWN))
    out.push(
      `      ${dynamicSlotLabel(slot)}${slot.partial === true ? " (dynamic pieces)" : ""}  ${c(DIM, `${where(slot.loc)}${(slot.operations ?? 0) > 0 ? `, ${slot.operations} dynamic operation${slot.operations === 1 ? "" : "s"}` : ""}`)}`,
    );
  if (slots.length > DYNAMIC_SLOTS_SHOWN)
    out.push(`      ${c(DIM, `and ${slots.length - DYNAMIC_SLOTS_SHOWN} more`)}`);
}

const SLOTS_SHOWN = 40;

/** The localized-failure section of --explain-dynamic (report-only): the
 * committed type failures that would become checked dynamic slots, and
 * the cascade each one causes today. */
function renderLocalizedFailure(
  report: LocalizedFailureReport,
  out: string[],
  c: (code: string, s: string) => string,
  where: (loc: { file: string; start: number }) => string,
): void {
  if (report.typeFailures.degradable === 0 && report.typeFailures.refused === 0) return;
  out.push("");
  out.push(
    `    ${report.slots.length} would-be dynamic slot${report.slots.length === 1 ? "" : "s"} ${c(DIM, "(localized failure, report-only: type failures a checked dynamic slot would hold)")}`,
  );
  out.push(
    `      ${c(DIM, `${report.errors} errors: ${report.clearedThroughL2} clear with declaration slots (L1-L2), ${report.clearedThroughL4} with member and expression slots too (L3-L4); ${report.cascades} cascade${report.cascades === 1 ? "" : "s"} attributed; ${report.typeFailures.refused} type failure${report.typeFailures.refused === 1 ? " stays" : "s stay"} refused`)}`,
  );
  for (const slot of report.slots.slice(0, SLOTS_SHOWN)) {
    const cascade = slot.cascade > 0 ? `, clears ${slot.cascade}` : "";
    out.push(
      `      ${slot.stage} ${slot.slot} ${slot.name}: ${capMessage(slot.declaredType)}  ${c(DIM, `${where(slot.loc)} (${slot.code} ${slot.family}${cascade})`)}`,
    );
    if (slot.rejects !== null)
      out.push(`        ${c(DIM, `rejects ${slot.rejects.split(" @")[0]}`)}`);
  }
  if (report.slots.length > SLOTS_SHOWN)
    out.push(
      `      ${c(DIM, `${report.slots.length - SLOTS_SHOWN} more (--print=diagnostics lists all)`)}`,
    );
}

/** `scriptc coverage --explain-dynamic[=<unit>]`: the dynamic tier today
 * and the demotion chains the report-only analysis computed. With a query,
 * only units whose name matches it (`x`, `Point.x`, `parse:x`). */
export function renderExplainDynamic(
  tiers: TierReport,
  opts: CoverageRenderOptions & { query?: string } = {},
): string {
  const c = (code: string, s: string) => (opts.color ? code + s + RESET : s);
  const locator = new SourceLocator(opts.sourceTexts);
  const where = (loc: { file: string; start: number }) => {
    const p = locator.position(loc.file, loc.start);
    return `${displayPath(loc.file, opts.root)}:${p.line}:${p.column}`;
  };
  const query = opts.query !== undefined && opts.query !== "" ? opts.query : undefined;
  const out: string[] = [];
  out.push(
    `  ${c(BOLD, "dynamic tier")}   ${c(DIM, `(tier assignment, report-only; --tier=${tiers.mode})`)}`,
  );
  if (query === undefined) {
    const fns = tiers.dynamicFunctions;
    out.push(
      `    ${fns.length} function${fns.length === 1 ? "" : "s"} already operate${fns.length === 1 ? "s" : ""} on dynamic values ${c(DIM, `(${tiers.statementsDynamic} statement${tiers.statementsDynamic === 1 ? "" : "s"})`)}`,
    );
    for (const fn of fns) {
      out.push(
        `      ${functionDisplayName(fn.name)}  ${c(DIM, `${where(fn.loc)}: ${fn.operation} at ${where(fn.operationLoc)}`)}`,
      );
    }
  }
  const live = tiers.requests.filter((r) => r.scope !== "unreached" && r.seed !== "excluded");
  const excluded = tiers.requests.filter((r) => r.seed === "excluded").length;
  const unreached = tiers.requests.filter((r) => r.scope === "unreached").length;
  if (query === undefined) {
    out.push("");
    out.push(
      `    ${live.length} demotion request${live.length === 1 ? "" : "s"} ${c(DIM, "(refusals and fences the dynamic tier would replace)")}` +
        (unreached > 0 ? c(DIM, `, ${unreached} more in unreached code`) : "") +
        (excluded > 0 ? c(DIM, `, ${excluded} excluded by policy`) : ""),
    );
  }
  if (query === undefined) renderLocalizedFailure(tiers.localizedFailure, out, c, where);
  const units = tiers.units.filter((u) => query === undefined || unitMatches(u, query));
  if (query !== undefined && units.length === 0) {
    out.push(`    no demoted unit matches '${query}'`);
    return out.join("\n");
  }
  for (const u of units) {
    const counts = [
      u.requests > 0 ? `${u.requests} request${u.requests === 1 ? "" : "s"}` : "",
      u.sites > 0 ? `${u.sites} site${u.sites === 1 ? "" : "s"} inside` : "",
    ]
      .filter((s) => s !== "")
      .join(", ");
    out.push(`    ${unitLabel(u, opts.root)}  ${c(DIM, `${where(u.loc)} (${counts})`)}`);
    if (query === undefined && u.requests === 0) continue;
    for (const r of live) {
      if (r.unit.kind !== u.kind || r.unit.name !== u.name || r.unit.loc.start !== u.loc.start)
        continue;
      if (r.unit.loc.file !== u.loc.file) continue;
      out.push(
        `      ${c(DIM, "<-")} ${r.code} ${r.seed} at ${where(r.loc)}: ${capMessage(r.message)}`,
      );
      if (r.enclosing.name !== r.unit.name || r.enclosing.kind !== r.unit.kind)
        out.push(`      ${c(DIM, "->")} ${unitLabel(r.enclosing, opts.root)} turns dynamic`);
    }
  }
  return out.join("\n");
}

/* ── Node islands (report-only) ───────────────────────────────────────── */

const ISLAND_REASONS_SHOWN = 1;

function islandName(i: { package: string; version: string | null }): string {
  return i.version === null ? i.package : `${i.package}@${i.version}`;
}

function renderNodeIslands(
  report: NodeIslandReport,
  out: string[],
  c: (code: string, s: string) => string,
  at: (loc: SrcLoc) => string,
  root: string | undefined,
): void {
  const n = report.islands.length + report.userModules.length;
  out.push(
    `  ${c(BOLD, "Node islands")}   ${c(DIM, `(would-be, report-only: the build is unchanged; --node-islands=${report.policy})`)}`,
  );
  if (n === 0) out.push(`    ${c(DIM, "none")}`);
  const widest = Math.max(0, ...report.islands.map((i) => i.class.length));
  for (const island of report.islands) {
    const tone = island.class === "gap" ? RED : YELLOW;
    const decided =
      island.decision === "auto"
        ? ""
        : c(
            DIM,
            ` (marked by ${island.decision === "cli" ? "--node-island" : "scriptc.packages"})`,
          );
    out.push(`    ${c(tone, island.class.padEnd(widest))}  ${islandName(island)}${decided}`);
    for (const r of island.reasons.slice(0, ISLAND_REASONS_SHOWN)) {
      const where = r.loc === null ? "" : `${at(r.loc)}: `;
      out.push(`          ${c(DIM, capMessage(`${where}${describeReason(r)}`))}`);
    }
    const more = island.reasons.length - ISLAND_REASONS_SHOWN;
    const details = [
      more > 0
        ? `+${more} more reason${more === 1 ? "" : "s"} in ${counted(island.modules, "module")}`
        : "",
      island.carries.length > 0 ? `carries ${island.carries.join(", ")}` : "",
    ].filter((t) => t !== "");
    if (details.length > 0) out.push(`          ${c(DIM, details.join("; "))}`);
  }
  for (const m of report.userModules) {
    out.push(
      `    ${c(YELLOW, "marked".padEnd(widest))}  ${displayPath(m.file, root)} ${c(DIM, `(user module, marked by ${m.source === "cli" ? "--node-island" : "nodeIslands.modules"})`)}`,
    );
  }
  for (const v of report.violations) {
    out.push(`    ${c(RED, v.code)}  ${capMessage(v.message)}`);
  }
  const shared = report.packages.filter((p) => p.status === "shared");
  if (shared.length > 0) {
    out.push(
      `    ${c(DIM, `reached from native code and from an island: ${shared.map((p) => p.package).join(", ")}`)}`,
    );
  }
  const native = report.packages.filter((p) => p.status === "native");
  if (native.length > 0) {
    out.push(
      `    ${c(DIM, `${counted(native.length, "package")} stay${native.length === 1 ? "s" : ""} native: ${native.map((p) => p.package).join(", ")}`)}`,
    );
  }
  if (report.unknownPackages.length > 0) {
    out.push(
      `    ${c(YELLOW, "note")}  not imported by the program: ${report.unknownPackages.join(", ")}`,
    );
  }
  if (report.islands.length > 0) {
    out.push(
      `    ${c(DIM, "hint: scriptc coverage --explain-island=<package> lists every reason")}`,
    );
  }
}

/** `scriptc coverage --explain-island=<package>`: why a package would run
 * in a Node island — every module's first reason, the native import sites
 * (the boundary), the packages inside its closure, and what later
 * milestones decide. */
export function renderExplainIsland(
  report: NodeIslandReport | undefined,
  query: string,
  opts: CoverageRenderOptions = {},
): string {
  const c = (code: string, s: string) => (opts.color ? code + s + RESET : s);
  const locator = new SourceLocator(opts.sourceTexts);
  const at = (loc: SrcLoc) => {
    const p = locator.position(loc.file, loc.start);
    return `${displayPath(loc.file, opts.root)}:${p.line}:${p.column}`;
  };
  const out: string[] = [];
  const matches = (report?.islands ?? []).filter(
    (i) => i.package === query || islandName(i) === query,
  );
  if (matches.length === 0) {
    const pkg = (report?.packages ?? []).find((p) => p.package === query);
    if (pkg === undefined) {
      out.push(`  '${query}' is not a Node island: no npm package of that name is in the program`);
    } else if (pkg.status === "inside") {
      out.push(
        `  '${query}' is not a Node island of its own: only ${pkg.islands.join(", ")} import${pkg.islands.length === 1 ? "s" : ""} it, so it would run inside that island`,
      );
    } else if (pkg.status === "shared") {
      out.push(
        `  '${query}' compiles natively and is also reached from the Node island${pkg.islands.length === 1 ? "" : "s"} ${pkg.islands.join(", ")}`,
      );
    } else {
      out.push(`  '${query}' is not a Node island: it compiles natively`);
    }
    return out.join("\n");
  }
  for (const island of matches) {
    out.push(
      `  ${c(BOLD, "Node island")} ${islandName(island)}   ${c(DIM, "(would-be, report-only)")}`,
    );
    if (island.path !== null) out.push(`    path        ${displayPath(island.path, opts.root)}`);
    out.push(`    class       ${island.class}: ${classDescription(island.class)}`);
    out.push(
      `    decision    ${island.decision === "auto" ? "automatic (npm code outside the native subset)" : island.decision === "cli" ? "marked with --node-island" : 'marked "node" in scriptc.packages'}`,
    );
    out.push(
      `    evaluation  eager at its module position ${c(DIM, "(deferred evaluation is decided by a later milestone)")}`,
    );
    if (island.reasons.length > 0) {
      out.push(`    reasons     ${c(DIM, "(first per module; decisive class first)")}`);
      const shown = new Set<string>();
      for (const r of island.reasons) {
        const key = r.loc === null ? "" : r.loc.file;
        if (shown.has(key)) continue;
        shown.add(key);
        const where = r.loc === null ? "package" : at(r.loc);
        out.push(`      ${r.class.padEnd(12)}  ${where}`);
        out.push(`        ${c(DIM, capMessage(describeReason(r)))}`);
      }
      const counts = new Map<string, number>();
      for (const r of island.reasons) counts.set(r.class, (counts.get(r.class) ?? 0) + 1);
      const summary = [...counts].map(([cls, k]) => `${k} ${cls}`).join(", ");
      out.push(`    all reasons ${island.reasons.length} (${summary})`);
    }
    if (island.importedFrom.length > 0) {
      out.push(`    boundary    ${counted(island.importedFrom.length, "native import site")}:`);
      for (const loc of island.importedFrom.slice(0, SITES_SHOWN)) out.push(`      ${at(loc)}`);
      if (island.importedFrom.length > SITES_SHOWN)
        out.push(`      ${c(DIM, `+${island.importedFrom.length - SITES_SHOWN} more`)}`);
      out.push(
        `      ${c(DIM, "copy and handle decisions per boundary site come with compiler-managed islands")}`,
      );
    } else {
      out.push(
        `    boundary    ${c(DIM, "no native import site (reached only from other islands)")}`,
      );
    }
    if (island.carries.length > 0) out.push(`    carries     ${island.carries.join(", ")}`);
  }
  return out.join("\n");
}

function nodeIslandsEnvelope(
  report: NodeIslandReport,
  locator: SourceLocator,
): NodeIslandsEnvelope {
  const pos = (loc: SrcLoc): SourcePosition => ({
    file: loc.file,
    ...locator.position(loc.file, loc.start),
  });
  const entry = (i: NodeIslandEntry) => {
    const first = i.reasons[0];
    return {
      package: i.package,
      version: i.version,
      path: i.path,
      class: i.class,
      reason: i.reason,
      diagnostic: i.diagnostic,
      decision: i.decision,
      evaluation: i.evaluation,
      ...(first !== undefined && first.loc !== null ? { at: pos(first.loc) } : {}),
      reasons: i.reasons.map((r) => ({
        class: r.class,
        rule: r.rule,
        reason: r.reason,
        code: r.code,
        message: r.message,
        source: r.source,
        ...(r.loc !== null ? { at: pos(r.loc) } : {}),
      })),
      carries: i.carries,
      importedFrom: i.importedFrom.map(pos),
    };
  };
  return {
    mode: report.mode,
    policy: report.policy,
    islands: report.islands.map(entry),
    userModules: report.userModules.map((m) => ({ file: m.file, decision: m.source })),
    npmPackages: report.packages.map((p) => ({
      package: p.package,
      version: p.version,
      path: p.path,
      status: p.status,
      islands: p.islands,
    })),
    violations: report.violations.map((v) => ({ code: v.code, message: v.message, ...pos(v.loc) })),
    unknownPackages: report.unknownPackages,
  };
}
