/* Shape inference stage S1: the plan the analysis would hand the lowering,
 * as a report (DESIGN.md §4.5, §5.5). Nothing here changes compilation.
 *
 * Per allocation site of package code, the verdict:
 *   P local     — a native record would be exact: no reflection, no added
 *                 keys, no computed writes, and its objects never escape;
 *   P escaping  — exact as a record behind identity-keeping capsules: it
 *                 escapes, but the census leaves every later operation
 *                 answerable (fields untyped code may write become dyn);
 *   G <reason>  — keeps today's dynamic object, with the rule that decided.
 * Plus class field types, the census, and the hot functions' value types. */
import * as ts from "../ts7/adapter.js";
import { OBJECT_PROTOTYPE_MEMBERS, type Atom } from "./domain.js";
import { locLabel, type FunctionInfo, type LiteralSite, type ShapeAnalysis } from "./analyze.js";

export interface SiteVerdict {
  readonly site: LiteralSite;
  readonly label: string;
  readonly verdict: "P-local" | "P-escaping" | "G";
  readonly reasons: string[];
  /** P-escaping: fields untyped code may write (they become dyn slots). */
  readonly writableByTop: string[];
  readonly freezable: boolean;
  readonly brand: boolean;
}

export interface ShapeReport {
  readonly sites: SiteVerdict[];
  readonly hot: Set<FunctionInfo>;
  readonly lines: string[];
}

const MAX_ATOMS_SHOWN = 6;

function fieldKeys(fields: ReadonlyMap<string, number> | undefined): string[] {
  return fields === undefined ? [] : [...fields.keys()];
}

function fieldEntries(fields: ReadonlyMap<string, number> | undefined): [string, number][] {
  return fields === undefined ? [] : [...fields.entries()];
}

export function describeValue(analysis: ShapeAnalysis, node: number): string {
  const atoms = [...analysis.nodes[node]!.atoms];
  if (atoms.length === 0) return "∅";
  const labels = [...new Set(atoms.map((a) => a.label))];
  labels.sort((a, b) => (a === "⊤" ? 1 : b === "⊤" ? -1 : a.localeCompare(b)));
  const shown = labels.slice(0, MAX_ATOMS_SHOWN).join(" | ");
  if (labels.length <= MAX_ATOMS_SHOWN) return shown;
  return `${shown} | +${labels.length - MAX_ATOMS_SHOWN}${labels.includes("⊤") ? " | ⊤" : ""}`;
}

function atomsOf(analysis: ShapeAnalysis, node: number): Set<Atom> {
  return analysis.nodes[node]!.atoms;
}

/** Functions reached from call sites in loops (or loop callbacks), and
 * everything they call: the static hotness heuristic (DESIGN.md §8.1). */
export function hotFunctions(analysis: ShapeAnalysis): Set<FunctionInfo> {
  const hot = new Set<FunctionInfo>();
  const callees = new Map<FunctionInfo | null, FunctionInfo[]>();
  const work: FunctionInfo[] = [];
  for (const c of analysis.calls) {
    let l = callees.get(c.caller);
    if (l === undefined) callees.set(c.caller, (l = []));
    l.push(c.callee);
    if (c.inLoop && !hot.has(c.callee)) {
      hot.add(c.callee);
      work.push(c.callee);
    }
  }
  while (work.length > 0) {
    const f = work.pop()!;
    for (const g of callees.get(f) ?? []) {
      if (!hot.has(g)) {
        hot.add(g);
        work.push(g);
      }
    }
  }
  return hot;
}

/** Operations that reach an escaped site through a ⊤ receiver. */
const TOP_REACHING: ReadonlySet<string> = new Set([
  "delete",
  "defineProperty",
  "setPrototypeOf",
  "seal",
  "proxy",
  "assign",
  "freeze",
  "lengthWrite",
]);

export function buildShapeReport(analysis: ShapeAnalysis, filter: string): ShapeReport {
  const lines: string[] = [];
  const all = filter === "all" || filter === "verbose";
  const verbose = filter === "verbose";
  const fileFilter = filter !== "1" && !all ? filter : null;
  const wanted = (n: ts.Node, inPackage: boolean): boolean => {
    if (fileFilter !== null) return n.getSourceFile().fileName.includes(fileFilter);
    return all || inPackage;
  };

  // Census facts: operations whose receiver may be ⊤ reach every escaped atom.

  // Index ops by the site atoms they can reach directly.
  const byAtom = new Map<Atom, typeof analysis.ops>();
  const topOps: typeof analysis.ops = [];
  for (const o of analysis.ops) {
    const atoms = atomsOf(analysis, o.recv);
    for (const a of atoms) {
      if (a.kind !== "object" && a.kind !== "array") continue;
      let l = byAtom.get(a);
      if (l === undefined) byAtom.set(a, (l = []));
      l.push(o);
    }
    if (atoms.has(analysis.top)) topOps.push(o);
  }
  // Through ⊤, only reflective operations and length writes reach an
  // escaped site (writes, reads and computed writes count only when the
  // site is a direct receiver). One per syntax node and kind: contexts repeat ops.
  const reflectiveTopOps: typeof analysis.ops = [];
  {
    const seen = new Set<string>();
    const ids = new Map<ts.Node, number>();
    for (const o of topOps) {
      if (!TOP_REACHING.has(o.kind)) continue;
      let id = ids.get(o.node);
      if (id === undefined) ids.set(o.node, (id = ids.size));
      const key = `${o.kind}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      reflectiveTopOps.push(o);
    }
  }

  // Key-order groups: sites with the same key set and different orders need brands.
  const orders = new Map<string, Set<string>>();
  for (const s of analysis.sites) {
    if (s.kind !== "object" || s.keys === null) continue;
    const set = [...s.keys].sort().join(",");
    let o = orders.get(set);
    if (o === undefined) orders.set(set, (o = new Set()));
    o.add(s.keys.join(","));
  }

  const verdicts: SiteVerdict[] = [];
  for (const s of analysis.sites) {
    if (!s.inPackage && !all && fileFilter === null) continue;
    const reasons: string[] = [];
    const escapedWhy = analysis.escaped.get(s.atom);
    const escapes = escapedWhy !== undefined;
    if (s.hasAccessor) reasons.push("accessor in literal");
    if (s.hasProto) reasons.push(s.kind === "array" ? "hole in literal" : "__proto__ in literal");
    if (s.hasComputedKey) reasons.push("computed key in literal");
    for (const sp of s.spreads)
      if (atomsOf(analysis, sp).has(analysis.top)) reasons.push("spread of ⊤");
    const direct = byAtom.get(s.atom) ?? [];
    const ops = escapes ? [...direct, ...reflectiveTopOps] : direct;
    const keys = new Set(s.keys ?? []);
    const fieldsOf = analysis.fields.get(s.atom);
    const knownKeys =
      s.keys !== null ? keys : new Set([...fieldKeys(fieldsOf)].filter((k) => k !== "*"));
    let freezable = false;
    const seen = new Set<string>();
    const note = (r: string): void => {
      if (!seen.has(r)) {
        seen.add(r);
        reasons.push(r);
      }
    };
    for (const o of ops) {
      const viaTop = !atomsOf(analysis, o.recv).has(s.atom);
      if (viaTop && !TOP_REACHING.has(o.kind)) continue;
      // Formatted only for a reason that is reported.
      const at = (): string => `${locLabel(o.node)}${viaTop ? " via ⊤" : ""}`;
      switch (o.kind) {
        case "delete":
        case "defineProperty":
        case "setPrototypeOf":
        case "seal":
        case "proxy":
          note(`${o.kind} at ${at()}`);
          break;
        case "assign":
          note(`Object.assign target at ${at()}`);
          break;
        case "freeze":
          freezable = true;
          break;
        case "computedWrite":
          if (!viaTop)
            note(s.kind === "array" ? `index write at ${at()}` : `computed write at ${at()}`);
          break;
        case "lengthWrite":
          if (s.kind === "array") note(`length write at ${at()}`);
          break;
        case "write":
          if (s.kind === "object" && !viaTop && o.name !== null && !knownKeys.has(o.name))
            note(`adds key '${o.name}' at ${at()}`);
          break;
        case "read":
          if (
            s.kind === "object" &&
            !underPromiseGuard(o.node) &&
            escapes &&
            o.name !== null &&
            !viaTop &&
            !knownKeys.has(o.name) &&
            !OBJECT_PROTOTYPE_MEMBERS.has(o.name)
          )
            note(`reads absent key '${o.name}' at ${at()} (escapes)`);
          break;
        default:
          break;
      }
    }
    let brand = false;
    if (s.kind === "object" && s.keys !== null) {
      const o = orders.get([...s.keys].sort().join(","));
      if (o !== undefined && o.size > 1) brand = true;
    }
    const writableByTop: string[] = [];
    if (escapes) {
      if (analysis.topComputedWrites.length > 0) writableByTop.push("*");
      else for (const k of knownKeys) if (analysis.topWriteNames.has(k)) writableByTop.push(k);
    }
    const verdict: SiteVerdict["verdict"] =
      reasons.length > 0 ? "G" : escapes ? "P-escaping" : "P-local";
    const label = s.atom.label;
    if (escapes) reasons.push(`escapes: ${escapedWhy}`);
    verdicts.push({ site: s, label, verdict, reasons, writableByTop, freezable, brand });
  }

  const hot = hotFunctions(analysis);
  const hotNodes = new Set<ts.Node>([...hot].map((f) => f.node));

  // ---- print ----
  const pkgFns = [...analysis.functions.values()].filter((f) => f.inPackage);
  lines.push(
    `analyzed ${analysis.files.length} files (${analysis.packageFiles} package JS), ${analysis.functions.size} functions (${pkgFns.length} in packages), ${analysis.atoms.atoms.length} atoms, ${analysis.nodes.length} value nodes, ${analysis.steps} steps${analysis.budgetExceeded ? " — BUDGET EXCEEDED, results incomplete" : ""}`,
  );
  const topNames = [...analysis.topWriteNames.entries()].map(
    ([n, node]) => `${n} (${locLabel(node)})`,
  );
  lines.push(
    `census: writes on ⊤ receivers: ${topNames.length === 0 ? "none" : topNames.slice(0, 20).join(", ")}${topNames.length > 20 ? ` +${topNames.length - 20}` : ""}`,
  );
  lines.push(
    `census: computed writes on ⊤ receivers: ${analysis.topComputedWrites.length === 0 ? "none" : analysis.topComputedWrites.slice(0, 8).map(locLabel).join(", ")}`,
  );
  const topReflect = topOps.filter(
    (o) =>
      o.kind !== "read" &&
      o.kind !== "computedRead" &&
      o.kind !== "write" &&
      o.kind !== "computedWrite",
  );
  lines.push(
    `census: reflection on ⊤ receivers: ${topReflect.length === 0 ? "none" : topReflect.map((o) => `${o.kind} (${locLabel(o.node)})`).join(", ")}`,
  );
  const escapedPkg = [...analysis.escaped.keys()].filter(
    (a) =>
      a.node !== undefined &&
      wanted(a.node, a.node.getSourceFile().fileName.includes("/node_modules/")),
  );
  lines.push(
    `escaped atoms: ${analysis.escaped.size} (${escapedPkg.length} shown below where relevant)`,
  );
  const firstEscapes = [...analysis.escaped.entries()]
    .filter(([, why]) => !why.startsWith("via "))
    .slice(0, 12);
  for (const [atom, why] of firstEscapes) lines.push(`  escape root: ${atom.label}: ${why}`);

  const counts = { "P-local": 0, "P-escaping": 0, G: 0 };
  const hotCounts = { "P-local": 0, "P-escaping": 0, G: 0 };
  const inHot = (n: ts.Node): boolean => {
    let p: ts.Node | undefined = n.parent;
    while (p !== undefined) {
      if (hotNodes.has(p)) return true;
      p = p.parent;
    }
    return false;
  };
  for (const v of verdicts) {
    counts[v.verdict]++;
    if (inHot(v.site.node)) hotCounts[v.verdict]++;
  }
  lines.push(
    `sites: ${verdicts.length} (P local ${counts["P-local"]}, P escaping ${counts["P-escaping"]}, G ${counts.G}); in hot functions: P local ${hotCounts["P-local"]}, P escaping ${hotCounts["P-escaping"]}, G ${hotCounts.G}`,
  );
  for (const v of verdicts) {
    if (!wanted(v.site.node, v.site.inPackage)) continue;
    if (!verbose && !inHot(v.site.node)) continue;
    const extra: string[] = [];
    if (v.brand) extra.push("needs brand (key order)");
    if (v.freezable) extra.push("freezable");
    if (v.writableByTop.length > 0) extra.push(`⊤-writable: ${v.writableByTop.join(",")}`);
    const fields = analysis.fields.get(v.site.atom);
    const ftypes =
      v.site.kind === "array"
        ? `elem: ${analysis.elements.has(v.site.atom) ? describeValue(analysis, analysis.elements.get(v.site.atom)!) : "∅"}`
        : fieldEntries(fields)
            .filter(([k]) => k !== "*")
            .map(([k, id]) => `${k}: ${describeValue(analysis, id)}`)
            .join("; ");
    lines.push(
      `site ${v.label}${inHot(v.site.node) ? " [hot]" : ""}: ${v.verdict}${v.reasons.length > 0 ? ` — ${v.reasons.join("; ")}` : ""}${extra.length > 0 ? ` [${extra.join("; ")}]` : ""}`,
    );
    if (ftypes.length > 0) lines.push(`    ${ftypes}`);
  }

  // Class fields.
  for (const atom of analysis.atoms.atoms) {
    if (atom.kind !== "instance" || atom.node === undefined) continue;
    const inPackage = atom.node.getSourceFile().fileName.includes("/node_modules/");
    if (!wanted(atom.node, inPackage)) continue;
    const fm = analysis.fields.get(atom);
    if (fm === undefined || fm.size === 0) continue;
    const esc = analysis.escaped.get(atom);
    const parts = [...fm.entries()].map(([k, id]) => {
      const w =
        esc !== undefined &&
        !k.startsWith("#") &&
        (analysis.topComputedWrites.length > 0 || analysis.topWriteNames.has(k))
          ? " (⊤-writable)"
          : "";
      return `${k}: ${describeValue(analysis, id)}${w}`;
    });
    lines.push(
      `class ${atom.label}${esc !== undefined ? ` (escapes: ${esc})` : ""}: ${parts.join("; ")}`,
    );
  }

  // Hot functions.
  const hotPkg = [...hot].filter((info) => wanted(info.node, info.inPackage));
  lines.push(`hot functions: ${hotPkg.length} (clones per receiver class counted separately)`);
  for (const info of hotPkg) {
    const n = info.node;
    const params = info.params.map((p, i) => `p${i}=${describeValue(analysis, p)}`).join(", ");
    const flags = [
      info.usesArguments ? "uses arguments" : "",
      analysis.escaped.size > 0 && [...analysis.escaped.keys()].some((a) => a.node === n)
        ? "escapes"
        : "",
    ].filter((x) => x !== "");
    lines.push(
      `fn ${info.label}${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}: this=${describeValue(analysis, info.thisNode)}${params.length > 0 ? `, ${params}` : ""}, ret=${describeValue(analysis, info.ret)}`,
    );
  }
  const why = process.env["SCRIPTC_DEBUG_SHAPES_WHY"];
  if (why !== undefined) {
    for (const info of analysis.functions.values()) {
      if (!info.label.startsWith(why)) continue;
      for (const [what, node] of [
        ["ret", info.ret],
        ...info.params.map((p, i) => [`p${i}`, p] as const),
      ] as const) {
        if (!analysis.nodes[node]!.atoms.has(analysis.top)) continue;
        lines.push(`why ⊤ in ${info.label} ${what}:`);
        let cur: number | string | undefined = node;
        for (let i = 0; i < 40 && typeof cur === "number"; i++) {
          lines.push(`    ${analysis.nodeLabel.get(cur) ?? `node ${cur}`}`);
          cur = analysis.topCause.get(cur);
        }
        if (typeof cur === "string") lines.push(`    seed: ${cur}`);
      }
    }
  }
  return { sites: verdicts, hot, lines };
}

/** A read inside the true arm of a promise test (`isAsync(x)`,
 * `x instanceof Promise`): flow-sensitive narrowing removes the record
 * arms there. Stage S1's locals are flow-insensitive, so the report
 * recognizes the guard syntactically. */
function underPromiseGuard(node: ts.Node): boolean {
  let child: ts.Node = node;
  let p = node.parent;
  while (p !== undefined && !ts.isFunctionLike(p)) {
    let cond: ts.Expression | undefined;
    if (ts.isIfStatement(p) && p.thenStatement === child) cond = p.expression;
    if (ts.isConditionalExpression(p) && p.whenTrue === child) cond = p.condition;
    if (cond !== undefined && isPromiseTest(cond)) return true;
    child = p;
    p = p.parent;
  }
  return false;
}

function isPromiseTest(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e)) return isPromiseTest(e.expression);
  if (ts.isBinaryExpression(e)) {
    if (e.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword)
      return ts.isIdentifier(e.right) && e.right.text === "Promise";
    if (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      return isPromiseTest(e.left) || isPromiseTest(e.right);
    return false;
  }
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression))
    return /^is(Async|Promise|Thenable)$/.test(e.expression.text);
  return false;
}
