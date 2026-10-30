/* Static-object specialization, stage 1 (DESIGN-constant-objects.md):
 * constant object graphs.
 *
 * An object literal is a SINGLETON when the code that creates it runs at
 * most once: at module top level, or in a function every call path to which
 * starts at module evaluation through exactly one call site outside loops
 * (IIFEs, revealing modules, init helpers). A singleton's field is CONSTANT
 * when every store to it runs in such once-only code, no reflective or
 * computed write reaches the object, and the object never escapes to code
 * the analysis cannot see. A constant object has only constant fields and a
 * fixed key set; constant objects whose constant fields point at each other
 * form a constant graph (`ns`, `ns.util`, `ns.util.trim`).
 *
 * This stage computes the graphs and reports them, with the rule that
 * demoted every near miss, and the reads and calls a later stage could fold.
 * Nothing reaches code generation. */
import * as ts from "../ts7/adapter.js";
import type { Atom } from "./domain.js";
import type { FunctionInfo, Op, ShapeAnalysis } from "./analyze.js";
import { npmStaticPackageOfPath } from "../npm-static.js";

type Node = ts.Node;

export interface ConstantField {
  readonly key: string;
  /** Distinct atoms the field may hold. */
  readonly values: readonly Atom[];
  /** Stores (the literal's own member included). */
  readonly stores: number;
}

/** An object the analysis tracks as one allocation: an object literal, a
 * function object (a namespace or an ES5 constructor), or a constructor's
 * default prototype object. */
export interface Candidate {
  readonly atom: Atom;
  /** The syntax that creates it (the literal or the function). */
  readonly node: Node;
  readonly kind: "literal" | "function" | "prototype";
  /** Keys the creating syntax itself defines. */
  readonly keys: readonly string[];
  /** Whether the creating syntax is a plain data literal. */
  readonly plain: boolean;
  readonly inPackage: boolean;
  /** The per-call-site clone that allocates it ("" outside clones). */
  readonly ctx?: string;
}

export interface ConstantObject {
  readonly site: Candidate;
  readonly fields: readonly ConstantField[];
  readonly frozen: boolean;
}

export interface NearMiss {
  readonly site: Candidate;
  /** Null when the whole object was demoted. */
  readonly key: string | null;
  readonly rule:
    | "init-factory"
    | "allocated-repeatedly"
    | "escapes"
    | "reflective-write"
    | "computed-write"
    | "literal-form"
    | "written-after-init"
    | "lazy-cache";
  readonly detail: string;
}

export interface ConstantGraphs {
  readonly objects: readonly ConstantObject[];
  readonly nearMisses: readonly NearMiss[];
  /** Reads `e.k` whose receiver is exactly one constant object and whose
   * field is constant, and the subset that are callees. */
  readonly foldableReads: number;
  readonly foldableCalls: number;
  /** Reads of a constant field through a receiver that may also be other
   * values. */
  readonly mixedReads: number;
  readonly once: (fn: Node) => boolean;
}

function isLoop(n: Node): boolean {
  return (
    ts.isForStatement(n) ||
    ts.isForInStatement(n) ||
    ts.isForOfStatement(n) ||
    ts.isWhileStatement(n) ||
    ts.isDoStatement(n)
  );
}

/** The function (or source file) whose body contains `n`. */
function ownerFunction(n: Node): Node {
  for (let p = n.parent; p !== undefined; p = p.parent) {
    if (ts.isSourceFile(p)) return p;
    if (ts.isFunctionLike(p) && (p as { body?: Node }).body !== undefined) return p;
  }
  return n.getSourceFile();
}

/** Whether `n` sits in a loop of its own function's body. */
function inLoop(n: Node, owner: Node): boolean {
  for (let p = n.parent; p !== undefined && p !== owner; p = p.parent) if (isLoop(p)) return true;
  return false;
}

function loc(n: Node): string {
  const sf = n.getSourceFile();
  const file = sf.fileName.split("/node_modules/").pop() ?? sf.fileName;
  return `${file.split("/").slice(-2).join("/")}:${sf.getLineAndCharacterOfPosition(ts.tokenStartOfNode(n)).line + 1}`;
}

/** `x.k || (x.k = v)`, `x.k ??= v`, `x.k ||= v`, `if (!x.k) x.k = v`. */
function isCacheStore(write: Node): boolean {
  let assign: Node | undefined = write.parent;
  while (assign !== undefined && ts.isParenthesizedExpression(assign)) assign = assign.parent;
  if (assign === undefined || !ts.isBinaryExpression(assign)) return false;
  const op = assign.operatorToken.kind;
  if (op === ts.SyntaxKind.BarBarEqualsToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken)
    return true;
  if (op !== ts.SyntaxKind.EqualsToken) return false;
  const text = write.getText();
  let up: Node | undefined = assign.parent;
  while (up !== undefined && ts.isParenthesizedExpression(up)) up = up.parent;
  if (
    up !== undefined &&
    ts.isBinaryExpression(up) &&
    (up.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      up.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) &&
    up.left.getText() === text
  )
    return true;
  for (let p: Node | undefined = assign.parent; p !== undefined; p = p.parent) {
    if (ts.isIfStatement(p)) {
      const cond = p.expression.getText().replace(/\s+/g, "");
      return cond === `!${text}` || cond === `${text}===undefined` || cond === `${text}==null`;
    }
    if (ts.isFunctionLike(p) || ts.isSourceFile(p)) break;
  }
  return false;
}

const OBJECT_DEMOTING: ReadonlySet<Op["kind"]> = new Set([
  "computedWrite",
  "delete",
  "defineProperty",
  "setPrototypeOf",
  "assign",
  "proxy",
]);

export function computeConstantGraphs(analysis: ShapeAnalysis): ConstantGraphs {
  const infosByNode = new Map<Node, FunctionInfo[]>();
  for (const info of analysis.functions.values()) {
    let l = infosByNode.get(info.node);
    if (l === undefined) infosByNode.set(info.node, (l = []));
    l.push(info);
  }
  const edgesTo = new Map<Node, (typeof analysis.calls)[number][]>();
  for (const e of analysis.calls) {
    let l = edgesTo.get(e.callee.node);
    if (l === undefined) edgesTo.set(e.callee.node, (l = []));
    l.push(e);
  }
  const escapedNodes = new Set<Node>([...analysis.escapedFunctions].map((f) => f.node));

  const onceMemo = new Map<Node, boolean>();
  const once = (fn: Node): boolean => {
    if (ts.isSourceFile(fn)) return true;
    const known = onceMemo.get(fn);
    if (known !== undefined) return known;
    onceMemo.set(fn, false); // a cycle is not once-only
    let result = false;
    const edges = edgesTo.get(fn) ?? [];
    if (
      infosByNode.has(fn) &&
      !escapedNodes.has(fn) &&
      edges.length > 0 &&
      new Set(edges.map((e) => e.site)).size === 1
    ) {
      result = edges.every(
        (e) =>
          !e.inLoop && e.caller !== null && !inLoop(e.site, e.caller.node) && once(e.caller.node),
      );
    }
    onceMemo.set(fn, result);
    return result;
  };

  // A per-call-site clone (analyze.ts siteClone) runs once when its one
  // call site runs once: its caller is module code, or another such clone.
  const edgesToInfo = new Map<FunctionInfo, (typeof analysis.calls)[number][]>();
  for (const e of analysis.calls) {
    let l = edgesToInfo.get(e.callee);
    if (l === undefined) edgesToInfo.set(e.callee, (l = []));
    l.push(e);
  }
  const onceInfoMemo = new Map<FunctionInfo, boolean>();
  const onceInfo = (info: FunctionInfo): boolean => {
    if (ts.isSourceFile(info.node)) return true;
    if (!info.ctx.includes("@S")) return once(info.node);
    const known = onceInfoMemo.get(info);
    if (known !== undefined) return known;
    onceInfoMemo.set(info, false);
    const edges = edgesToInfo.get(info) ?? [];
    const result =
      !escapedNodes.has(info.node) &&
      edges.length > 0 &&
      new Set(edges.map((e) => e.site)).size === 1 &&
      edges.every(
        (e) =>
          !e.inLoop && e.caller !== null && !inLoop(e.site, e.caller.node) && onceInfo(e.caller),
      );
    onceInfoMemo.set(info, result);
    return result;
  };

  // Whether every call of a function comes from once-only code outside
  // loops, through any number of call sites: an init factory, whose
  // allocations are one object per call site (schema builders called at
  // module initialization).
  const initOnlyMemo = new Map<Node, boolean>();
  const initOnly = (fn: Node): boolean => {
    if (ts.isSourceFile(fn)) return true;
    const known = initOnlyMemo.get(fn);
    if (known !== undefined) return known;
    initOnlyMemo.set(fn, false);
    const edges = edgesTo.get(fn) ?? [];
    const result =
      infosByNode.has(fn) &&
      !escapedNodes.has(fn) &&
      edges.length > 0 &&
      edges.every(
        (e) =>
          !e.inLoop &&
          e.caller !== null &&
          !inLoop(e.site, e.caller.node) &&
          (once(e.caller.node) || initOnly(e.caller.node)),
      );
    initOnlyMemo.set(fn, result);
    return result;
  };

  const opsByAtom = new Map<Atom, Op[]>();
  for (const op of analysis.ops) {
    for (const a of analysis.nodes[op.recv]!.atoms) {
      let l = opsByAtom.get(a);
      if (l === undefined) opsByAtom.set(a, (l = []));
      l.push(op);
    }
  }

  const objects: ConstantObject[] = [];
  const nearMisses: NearMiss[] = [];
  const constantKeys = new Map<Atom, Set<string>>();
  const candidates: Candidate[] = [];
  for (const site of analysis.sites) {
    if (site.kind !== "object") continue;
    candidates.push({
      atom: site.atom,
      node: site.node,
      kind: "literal",
      keys: site.keys ?? [],
      plain: !(
        site.hasAccessor ||
        site.hasComputedKey ||
        site.spreads.length > 0 ||
        site.keys === null
      ),
      inPackage: site.inPackage,
      ctx: site.ctx,
    });
  }
  const inPackage = (n: Node): boolean =>
    npmStaticPackageOfPath(n.getSourceFile().fileName) !== null;
  for (const atom of analysis.atoms.atoms) {
    if (atom.kind !== "function" || atom.node === undefined) continue;
    const hasFields = (analysis.fields.get(atom)?.size ?? 0) > 0;
    const proto = analysis.protoOf.get(atom);
    if (!hasFields && proto === undefined) continue;
    candidates.push({
      atom,
      node: atom.node,
      kind: "function",
      keys: [],
      plain: true,
      inPackage: inPackage(atom.node),
    });
    if (proto !== undefined)
      candidates.push({
        atom: proto,
        node: atom.node,
        kind: "prototype",
        keys: ["constructor"],
        plain: true,
        inPackage: inPackage(atom.node),
      });
  }
  for (const site of candidates) {
    // A function object is created where its expression or declaration
    // runs; its prototype with it.
    const owner = ownerFunction(site.node);
    // Allocated in a per-call-site clone: once when that clone runs once.
    const cloneOwner =
      site.ctx !== undefined && site.ctx !== ""
        ? infosByNode.get(owner)?.find((i) => i.ctx === site.ctx)
        : undefined;
    const runsOnce = cloneOwner !== undefined ? onceInfo(cloneOwner) : once(owner);
    if (!runsOnce || inLoop(site.node, owner)) {
      const factory = !inLoop(site.node, owner) && initOnly(owner);
      if (site.inPackage || factory)
        nearMisses.push({
          site,
          key: null,
          rule: factory ? "init-factory" : "allocated-repeatedly",
          detail: factory
            ? `one object per call of ${loc(owner)} (${new Set((edgesTo.get(owner) ?? []).map((e) => e.site)).size} call sites)`
            : `created in ${owner.kind === ts.SyntaxKind.SourceFile ? "a module loop" : loc(owner)}`,
        });
      continue;
    }
    const escaped = analysis.escaped.get(site.atom);
    if (escaped !== undefined) {
      nearMisses.push({ site, key: null, rule: "escapes", detail: escaped });
      continue;
    }
    if (!site.plain) {
      nearMisses.push({
        site,
        key: null,
        rule: "literal-form",
        detail: "accessor, computed key or spread in the literal",
      });
      continue;
    }
    const ops = opsByAtom.get(site.atom) ?? [];
    const demoting = ops.find((op) => OBJECT_DEMOTING.has(op.kind));
    if (demoting !== undefined) {
      nearMisses.push({
        site,
        key: null,
        rule: demoting.kind === "computedWrite" ? "computed-write" : "reflective-write",
        detail: `${demoting.kind} at ${loc(demoting.node)}`,
      });
      continue;
    }
    const frozen = ops.some((op) => op.kind === "freeze");
    const stores = new Map<string, number>();
    for (const k of site.keys) stores.set(k, 1);
    // A function's own data fields come only from stores.
    const demotedKeys = new Map<string, NearMiss>();
    for (const op of ops) {
      // A `length` store on an object (not an array) is an ordinary write.
      if ((op.kind !== "write" && op.kind !== "lengthWrite") || op.name === null) continue;
      stores.set(op.name, (stores.get(op.name) ?? 0) + 1);
      const fn = ownerFunction(op.node);
      if (once(fn) && !inLoop(op.node, fn)) continue;
      if (demotedKeys.has(op.name)) continue;
      demotedKeys.set(op.name, {
        site,
        key: op.name,
        rule: isCacheStore(op.node) ? "lazy-cache" : "written-after-init",
        detail: loc(op.node),
      });
    }
    for (const miss of demotedKeys.values()) nearMisses.push(miss);
    const fieldMap = analysis.fields.get(site.atom) ?? new Map<string, number>();
    const fields: ConstantField[] = [];
    const keys = new Set<string>();
    for (const [key, count] of stores) {
      if (demotedKeys.has(key)) continue;
      const id = fieldMap.get(key);
      const values = id === undefined ? [] : [...analysis.nodes[id]!.atoms];
      fields.push({ key, values, stores: count });
      keys.add(key);
    }
    constantKeys.set(site.atom, keys);
    if (demotedKeys.size === 0) objects.push({ site, fields, frozen });
  }

  let foldableReads = 0,
    foldableCalls = 0,
    mixedReads = 0;
  for (const op of analysis.ops) {
    if (op.kind !== "read" || op.name === null) continue;
    // A nullish receiver throws (absent keys read undefined in the analysis).
    const optional = (op.node.flags & ts.NodeFlags.OptionalChain) !== 0;
    const atoms = [...analysis.nodes[op.recv]!.atoms].filter(
      (a) => optional || !(a.kind === "prim" && (a.label === "undefined" || a.label === "null")),
    );
    const constant = atoms.filter((a) => constantKeys.get(a)?.has(op.name!) === true);
    if (constant.length === 0) continue;
    if (atoms.length === 1) {
      foldableReads++;
      const p = op.node.parent;
      if (p !== undefined && ts.isCallExpression(p) && p.expression === op.node) foldableCalls++;
    } else mixedReads++;
  }
  return { objects, nearMisses, foldableReads, foldableCalls, mixedReads, once };
}

/** Report lines (SCRIPTC_DEBUG_SHAPES=const): per package, the constant
 * graphs with their roots, the near misses by rule, and the foldable reads. */
export function constantGraphReport(analysis: ShapeAnalysis, graphs: ConstantGraphs): string[] {
  const lines: string[] = [];
  const pkgOf = (site: Candidate): string =>
    npmStaticPackageOfPath(site.node.getSourceFile().fileName) ?? "<user>";
  const byPkg = new Map<string, { objects: ConstantObject[]; misses: NearMiss[] }>();
  const entry = (pkg: string) => {
    let e = byPkg.get(pkg);
    if (e === undefined) byPkg.set(pkg, (e = { objects: [], misses: [] }));
    return e;
  };
  for (const o of graphs.objects) entry(pkgOf(o.site)).objects.push(o);
  for (const m of graphs.nearMisses) entry(pkgOf(m.site)).misses.push(m);
  const constantAtoms = new Set(graphs.objects.map((o) => o.site.atom));
  const referenced = new Set<Atom>();
  for (const o of graphs.objects)
    for (const f of o.fields)
      if (f.values.length === 1 && constantAtoms.has(f.values[0]!)) referenced.add(f.values[0]!);
  const describe = (o: ConstantObject, depth: number, seen: Set<Atom>): string => {
    const parts = o.fields.map((f) => {
      if (f.values.length !== 1)
        return `${f.key}: ${f.values.length === 0 ? "?" : f.values.map((a) => a.label).join("|")}`;
      const v = f.values[0]!;
      const child = graphs.objects.find((x) => x.site.atom === v);
      if (child !== undefined && depth < 3 && !seen.has(v)) {
        seen.add(v);
        return `${f.key}: ${describe(child, depth + 1, seen)}`;
      }
      return `${f.key}: ${v.kind === "function" && child === undefined ? "fn" : v.label}`;
    });
    const shown = parts.length > 8 ? [...parts.slice(0, 8), `… ${parts.length - 8} more`] : parts;
    return `{${shown.join(", ")}}${o.frozen ? " (frozen)" : ""}`;
  };
  lines.push(
    `analysis ${analysis.steps} steps${analysis.budgetExceeded ? " (BUDGET EXCEEDED: facts incomplete)" : ""}, ${analysis.files.length} files`,
  );
  lines.push(
    `constant objects ${graphs.objects.length}, near misses ${graphs.nearMisses.length}; foldable reads ${graphs.foldableReads} (calls ${graphs.foldableCalls}), mixed-receiver reads ${graphs.mixedReads}`,
  );
  for (const [pkg, e] of [...byPkg].sort((a, b) => a[0].localeCompare(b[0]))) {
    const fields = e.objects.reduce((n, o) => n + o.fields.length, 0);
    const rules = new Map<string, number>();
    for (const m of e.misses) rules.set(m.rule, (rules.get(m.rule) ?? 0) + 1);
    lines.push(
      `${pkg}: ${e.objects.length} constant objects (${fields} fields); near misses ${[...rules].map(([r, n]) => `${r} ${n}`).join(", ") || "none"}`,
    );
    for (const o of e.objects) {
      if (referenced.has(o.site.atom)) continue;
      lines.push(`  graph ${loc(o.site.node)} ${describe(o, 0, new Set([o.site.atom]))}`);
    }
    for (const m of e.misses.filter((x) => x.rule !== "allocated-repeatedly").slice(0, 40)) {
      lines.push(
        `  near miss ${loc(m.site.node)}${m.key === null ? "" : ` .${m.key}`}: ${m.rule} (${m.detail})`,
      );
    }
  }
  return lines;
}
