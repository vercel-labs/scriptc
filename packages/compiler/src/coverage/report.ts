/* The static coverage report — the product's thesis rendered as text.
 *
 * Reframes "does my program compile?" (binary, frustrating) into "how static
 * is my program?" (a gradient you can improve): how many statements lowered
 * to native code and what exactly blocked the rest, blockers grouped by
 * code and ordered by impact. Built entirely from what the lowerer already
 * collects — the diagnostics registry is the coverage taxonomy.
 */
import type { Milestone, ScrDiagnostic } from "../diagnostics/diagnostic.js";
import { renderDiagnostics } from "../diagnostics/render.js";
import type { LowerStats } from "../frontend/lowering/lowerer.js";
import type { NpmBuiltinUse, NpmLazyTrap } from "../frontend/npm.js";
import type { ProvenanceSources } from "../frontend/provenance-registry.js";

export interface CoverageInput {
  file: string;
  /** Analyzed as a --dynamic build: island sites LOWER (their statements
   * land in stats.statementsIsland) instead of SC2013-fencing, and the
   * report renders them as "compile dynamically". */
  dynamic?: boolean;
  stats: LowerStats;
  diagnostics: ScrDiagnostic[];
  /** JS statements whose compile fences deferred to RUNTIME (runtimeFence
   * statements): the program builds, but executing one throws — the
   * report lists them so nothing hides. */
  runtimeFences?: ScrDiagnostic[];
  /** The unreached remainder: bodies nothing on the entry path reaches,
   * lowered in a throwaway analysis pass. Its blockers cannot fail a
   * build — the report shows them as a secondary, dimmed group. */
  unreached?: { stats: LowerStats; diagnostics: ScrDiagnostic[] };
  /** --dynamic only: every Node builtin the embedded npm graph imports —
   * what the island must provide for this program (unshimmed ones also
   * appear as SC2030 blockers, EXCEPT lazily-reached ones, which embed
   * the island's call-time throw instead of failing the build). */
  npmBuiltins?: NpmBuiltinUse[];
  /** --dynamic only: unresolvable specifiers reached ONLY by require()/
   * import() edges — embedded as runtime traps with Node's call-time
   * error shape; listed in the builtins table so the build output stays
   * honest about what the binary cannot reach. */
  npmLazyTraps?: NpmLazyTrap[];
  /** --npm-static: each requested (or auto-detected) package's outcome —
   * compiled statically as program modules, or fallen back to the island
   * with the first refusal reason. */
  npmStatic?: NpmStaticStatus[];
  /** --provenance-sources: the resolved source-mapped packages and the
   * fallback notes — the report renders per-package attribution from
   * statsByFile (statements inside each package's source dir). */
  provenance?: ProvenanceSources;
  /** --provenance-sources: per-file statement attribution from the emit
   * pass (LowerResult.statsByFile). */
  statsByFile?: Map<string, { total: number; failed: number; island: number }>;
  /** --provenance-sources: diagnostics of elided pure-annotated dead
   * consts (off the build; the provenance section names them). */
  provenanceElided?: ScrDiagnostic[];
  /** True when tsc preflight failed — no coverage can be computed. */
  preflightFailed: boolean;
}

/** One file of a --npm-static package's outcome (package rows split per
 * file when the frontend judges files, not just packages). */
export interface NpmStaticFileStatus {
  /** The file's path relative to the package root — the report renders
   * package-relative names so a dist/lib split reads at a glance. */
  file: string;
  status: "static" | "fallback";
  /** The fallback's first refusal reason (fallback rows only). */
  detail?: string;
}

/** One --npm-static package's outcome for the report. */
export interface NpmStaticStatus {
  package: string;
  status: "static" | "fallback";
  /** The fallback's first refusal reason (fallback rows only). */
  detail?: string;
  /** File-granular outcomes inside the package: a static package whose
   * minified dist islanded per file while its readable lib stayed static
   * reports one row per judged file. Absent = the package is
   * package-granular (every file shares the package's status). */
  files?: NpmStaticFileStatus[];
}

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const MILESTONE_ORDER: Milestone[] = ["M1", "M2", "M3", "M4", "M5", "later"];

/** Codes whose construct RUNS under --dynamic (the embedded engine) — the
 * report separates "one flag away" from "cannot compile at all". */
const DYNAMIC_CAPABLE = new Set(["SC2010", "SC2011", "SC2012", "SC2013"]);

interface Blocker {
  code: string;
  /** Message with the " (planned: ...)" suffix stripped — the milestone gets
   * its own column. */
  what: string;
  milestone: Milestone | undefined;
  count: number;
}

export function renderCoverage(input: CoverageInput, opts: { color?: boolean; sourceTexts?: Map<string, string> } = {}): string {
  const c = (code: string, s: string) => (opts.color ? code + s + RESET : s);
  const out: string[] = [];
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
    const tsc = input.diagnostics.filter((d) => d.code === "SC0001");
    if (tsc.length > 0) {
      out.push(
        `  ${c(RED, "not analyzable")}: ${tsc.length} TypeScript error${tsc.length === 1 ? "" : "s"} — ` +
          `fix type errors first (scriptc only analyzes programs that typecheck)`,
      );
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
    const blockers = groupBlockers(input.diagnostics);
    const widest = Math.max(...blockers.map((b) => b.what.length));
    for (const b of blockers) {
      out.push(
        `    ${c(RED, `×${b.count}`.padStart(4))}  ${b.what.padEnd(widest)}  ${c(DIM, b.code)}`,
      );
    }
    if (opts.sourceTexts) {
      out.push("");
      out.push(renderDiagnostics(input.diagnostics, opts.sourceTexts, { color: opts.color ?? false }));
    }
    return out.join("\n");
  }

  // Top-line numbers stay whole-program: reached statements plus the
  // unreached remainder the analysis lowered anyway. Under --dynamic the
  // island-lowered statements split out as "compile dynamically" — they
  // BUILD, but their work runs in the embedded engine, and counting them
  // as static would overstate how native the program is.
  const un = input.unreached;
  const total = input.stats.statementsTotal + (un?.stats.statementsTotal ?? 0);
  const failed = input.stats.statementsFailed + (un?.stats.statementsFailed ?? 0);
  const island = input.stats.statementsIsland + (un?.stats.statementsIsland ?? 0);
  const skipped = input.stats.functionsSkipped + (un?.stats.functionsSkipped ?? 0);
  const ok = total - failed - island;
  const pct = total === 0 ? 100 : Math.floor((ok / total) * 100);
  const pctColor = pct === 100 ? GREEN : pct >= 75 ? YELLOW : RED;

  out.push(`  statements analyzed   ${total}`);
  out.push(`  compile statically    ${ok}  ${c(pctColor, c(BOLD, `(${pct}%)`))}`);
  if (input.dynamic) {
    const ipct = total === 0 ? 0 : Math.floor((island / total) * 100);
    out.push(
      `  compile dynamically   ${island}  ${c(YELLOW, c(BOLD, `(${ipct}%)`))} ${c(DIM, "(island sites — the embedded engine runs them)")}`,
    );
  }
  if (skipped > 0) {
    out.push(
      `  ${c(DIM, `(+${skipped} function${skipped === 1 ? "" : "s"} not analyzed — signature blocked)`)}`,
    );
  }
  out.push("");

  // --npm-static outcomes: which opted-in packages compiled statically as
  // program modules and which fell back to the island (with the first
  // refusal reason) — the flag's honesty section. A package carrying
  // file-granular outcomes renders its files beneath the package row:
  // `static` versus `island fallback (reason)` per FILE, so a package
  // that is part-static part-island never hides behind its package row.
  const npmStatic = input.npmStatic ?? [];
  if (npmStatic.length > 0) {
    out.push(`  ${c(DIM, "npm packages compiled statically (--npm-static):")}`);
    const widestP = Math.max(...npmStatic.map((s) => s.package.length));
    const statusText = (s: { status: "static" | "fallback"; detail?: string }): string =>
      s.status === "static"
        ? c(GREEN, "static")
        : c(YELLOW, "island fallback") + (s.detail !== undefined ? ` ${c(DIM, `(${s.detail})`)}` : "");
    for (const s of npmStatic) {
      out.push(`    ${s.package.padEnd(widestP)}  ${statusText(s)}`);
      const files = s.files ?? [];
      if (files.length > 0) {
        const widestF = Math.max(...files.map((f) => f.file.length));
        for (const f of files) {
          out.push(`        ${f.file.padEnd(widestF)}  ${statusText(f)}`);
        }
      }
    }
    out.push("");
  }

  // What the embedded npm code asks of the island: every Node builtin the
  // graph imports, with its shim status, plus every unresolvable specifier
  // only require()/import() edges reach. Eagerly-blocked builtins also
  // surface as SC2030 blockers below; "lazy trap" rows DON'T fail the
  // build — the binary embeds Node's call-time error and the call throws
  // at runtime, exactly where Node would have failed.
  const builtins = (input.dynamic && input.npmBuiltins) || [];
  const traps = (input.dynamic && input.npmLazyTraps) || [];
  if (builtins.length > 0 || traps.length > 0) {
    out.push(
      `  ${c(DIM, traps.length > 0 ? "embedded npm code imports Node builtins and unresolved specifiers:" : "embedded npm code imports Node builtins:")}`,
    );
    const widestB = Math.max(
      ...builtins.map((b) => b.builtin.length),
      ...traps.map((t) => t.specifier.length),
    );
    // Pad the plain words before coloring — escape codes have no width.
    const widestS = Math.max(
      ...builtins.map((b) => (b.shimmed ? 7 : b.lazy ? 23 : 11)),
      ...traps.map(() => 24),
    );
    for (const b of builtins) {
      const status = b.shimmed
        ? c(GREEN, "shimmed".padEnd(widestS))
        : b.lazy
          ? c(YELLOW, "not shimmed — lazy trap".padEnd(widestS))
          : c(RED, "not shimmed".padEnd(widestS));
      out.push(
        `    ${b.builtin.padEnd(widestB)}  ${status}  ${c(DIM, `(${b.packages.join(", ")})`)}`,
      );
    }
    for (const t of traps) {
      // A native .node addon RESOLVED — the island cannot dlopen it, so
      // the build embedded a throwing ERR_DLOPEN_FAILED stub instead of
      // the addon's machine code; unresolvable rows keep Node's not-found
      // error shapes.
      const what = t.native ? "native addon — lazy trap" : "unresolvable — lazy trap";
      out.push(
        `    ${t.specifier.padEnd(widestB)}  ${c(YELLOW, what.padEnd(widestS))}  ` +
          c(DIM, `(${t.via.join("/")} in ${t.packages.join(", ")})`),
      );
    }
    if (builtins.some((b) => b.lazy) || traps.length > 0) {
      out.push(
        `    ${c(DIM, "(lazy trap: only reachable through require()/import() boundaries — the build embeds Node's call-time error; the call throws at runtime)")}`,
      );
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
    out.push(`  ${c(BOLD, "provenance sources")}   ${c(DIM, "(attested source compiled as program modules)")}`);
    for (const pkg of prov.packages) {
      let pTotal = 0;
      let pFailed = 0;
      let pIsland = 0;
      const dir = pkg.dir.endsWith("/") ? pkg.dir : `${pkg.dir}/`;
      for (const [file, s] of input.statsByFile ?? []) {
        if (!file.startsWith(dir)) continue;
        pTotal += s.total;
        pFailed += s.failed;
        pIsland += s.island;
      }
      const elided = (input.provenanceElided ?? []).filter((d) => d.loc.file.startsWith(dir)).length;
      const pOk = pTotal - pFailed - pIsland;
      const pPct = pTotal === 0 ? 100 : Math.floor((pOk / pTotal) * 100);
      const pColor = pPct === 100 ? GREEN : pPct >= 75 ? YELLOW : RED;
      const shortRepo = pkg.repo.replace(/^git\+/, "").replace(/^https:\/\//, "").replace(/@refs\/.*$/, "");
      out.push(
        `    ${pkg.name}@${pkg.version}  ${c(DIM, `${shortRepo} @ ${pkg.commit.slice(0, 12)}`)}`,
      );
      out.push(
        `      ${pTotal} statements: ${pOk} static ${c(pColor, c(BOLD, `(${pPct}%)`))}, ${pIsland} island, ${pFailed} fenced` +
          (elided > 0 ? ` ${c(DIM, `(${elided} fence${elided === 1 ? "" : "s"} elided as @__PURE__ dead consts — uses would fence per site)`)}` : ""),
      );
    }
    for (const note of prov.notes) out.push(`    ${c(YELLOW, "note")}  ${note}`);
    out.push("");
  }

  // JS statements whose fences DEFERRED to runtime (the runtimeFence
  // statements the module carries): they compile, but executing one
  // throws its SC-coded error — the report lists them so a "compiling"
  // JS program never hides its dynamic gaps.
  const fences = input.runtimeFences ?? [];
  if (fences.length > 0) {
    const grouped = groupBlockers(fences);
    const widestF = Math.max(...grouped.map((b) => b.what.length));
    out.push(
      `  ${c(YELLOW, "deferred to runtime")}   ${fences.length} site${fences.length === 1 ? "" : "s"} ${c(DIM, "(JS statements that throw their fence if executed)")}`,
    );
    for (const b of grouped) {
      out.push(
        `    ${c(YELLOW, `×${b.count}`.padStart(4))}  ${b.what.padEnd(widestF)}  ${c(DIM, b.code)}`,
      );
    }
    out.push("");
  }

  const unreachedDiags = un?.diagnostics ?? [];
  if (failed === 0 && input.diagnostics.length === 0 && unreachedDiags.length === 0) {
    out.push(
      island > 0
        ? `  ${c(GREEN, "builds with --dynamic")} — no remaining blockers (the island sites above run in the embedded engine).`
        : `  ${c(GREEN, "fully static")} — this program has no dynamic remainder.`,
    );
    return out.join("\n");
  }

  // Ordered by internal scheduling (soonest first), then by frequency —
  // the top line is the blocker most likely to disappear next. The
  // milestone labels themselves are maintainer business and never rendered.
  // Blockers split by what a flag can fix: sites that RUN under --dynamic
  // (the embedded engine) versus constructs with no lowering at all.
  const blockers = groupBlockers(input.diagnostics);
  const unreachedBlockers = groupBlockers(unreachedDiags);
  const dynamic = blockers.filter((b) => DYNAMIC_CAPABLE.has(b.code));
  const rejected = blockers.filter((b) => !DYNAMIC_CAPABLE.has(b.code));
  const widest = Math.max(...[...blockers, ...unreachedBlockers].map((b) => b.what.length));
  const renderGroup = (group: Blocker[], dim = false) => {
    for (const b of group) {
      const what = b.what.padEnd(widest);
      out.push(
        `    ${c(dim ? DIM : RED, `×${b.count}`.padStart(4))}  ${dim ? c(DIM, what) : what}  ${c(DIM, b.code)}`,
      );
    }
  };
  if (dynamic.length > 0) {
    const sites = dynamic.reduce((n, b) => n + b.count, 0);
    out.push(
      `  ${c(YELLOW, `runs with --dynamic`)}   ${sites} site${sites === 1 ? "" : "s"} ${c(DIM, "(embeds a JS engine, ~620KB — static stays the default)")}`,
    );
    renderGroup(dynamic);
    out.push("");
  }
  if (rejected.length > 0) {
    out.push(`  blockers:`);
    renderGroup(rejected);
  }
  // Blockers in code nothing on the entry path reaches: never lowered by
  // a build, so they cannot fail one — secondary by design.
  if (unreachedBlockers.length > 0) {
    if (rejected.length > 0) out.push("");
    out.push(`  ${c(DIM, "in unreached code")}   ${c(DIM, "(never lowered — cannot fail a build)")}`);
    renderGroup(unreachedBlockers, true);
  }
  return out.join("\n");
}

function DIMPath(file: string, color: boolean): string {
  return color ? DIM + file + RESET : file;
}

function groupBlockers(diags: ScrDiagnostic[]): Blocker[] {
  const byCode = new Map<string, Blocker>();
  for (const d of diags) {
    const what = d.message.replace(/ (?:is|are) not supported yet$/, "");
    const key = `${d.code}:${what}`;
    const existing = byCode.get(key);
    if (existing) existing.count++;
    else byCode.set(key, { code: d.code, what, milestone: d.milestone, count: 1 });
  }
  const rank = (m: Milestone | undefined) =>
    m === undefined ? MILESTONE_ORDER.length : MILESTONE_ORDER.indexOf(m);
  return [...byCode.values()].sort(
    (a, b) =>
      rank(a.milestone) - rank(b.milestone) ||
      b.count - a.count ||
      a.code.localeCompare(b.code),
  );
}
