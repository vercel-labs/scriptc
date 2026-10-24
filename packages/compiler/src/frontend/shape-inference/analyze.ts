/* Shape inference (results/design-shape-inference/DESIGN.md), stage S1:
 * a whole-program allocation-site points-to analysis over the JavaScript of
 * opted-in npm packages and the user files that call into them.
 *
 * Stage S1 is report-only: the analysis runs when SCRIPTC_DEBUG_SHAPES is
 * set and prints its plan (report.ts). Nothing it computes reaches the
 * lowering yet, so every program compiles exactly as before.
 *
 * The analysis (DESIGN.md §4):
 * - Andersen-style inclusion constraints, solved with a worklist. Locals
 *   and parameters are one value node per binding (flow-insensitive in S1);
 *   heap fields are one node per (atom, name); arrays one element node.
 * - Calls resolve by the callee's atoms: functions, class constructors,
 *   methods by the receiver's class chain (inherited members, getters and
 *   setters, `this.constructor`), closures stored in fields, `bind`, and
 *   builtin summaries for the common library surface.
 * - Escape: an atom escapes when it reaches code the analysis cannot see
 *   (a ⊤ callee, a builtin without a summary, a store into a ⊤ object).
 *   Escaped functions run with ⊤ arguments; everything reachable from an
 *   escaped atom escapes.
 * - Census: writes and reflection whose receiver may be ⊤ apply to every
 *   escaped atom (§5.4); the report uses them to decide which allocation
 *   sites could become native records (§5.5). */
import * as ts from "../ts7/adapter.js";
import { isJsSourceFile } from "../program.js";
import { npmStaticPackageOfPath } from "../npm-static.js";
import { AtomTable, MODELED_GLOBALS, STRING_METHOD_RESULTS, type Atom } from "./domain.js";

type Node = ts.Node;

export interface ValueNode {
  readonly id: number;
  readonly atoms: Set<Atom>;
  readonly succ: Set<number>;
  /** Constraints to run for each atom that arrives. */
  readonly onAtom: ((atom: Atom) => void)[];
  /** Every atom that arrives escapes. */
  escapeSink: string | null;
}

export interface FunctionInfo {
  readonly node: Node;
  /** The analysis context: "" or a method's receiver (`C<atom id>`). */
  readonly ctx: string;
  /** The function whose clone the context is (bindings inside it are per context). */
  readonly root: Node | null;
  /** Bodies are walked on first call: code that never runs adds no facts. */
  walked: boolean;
  readonly label: string;
  readonly params: number[];
  /** Index of a rest parameter, or -1. */
  readonly rest: number;
  readonly thisNode: number;
  readonly ret: number;
  readonly isArrow: boolean;
  readonly isAsync: boolean;
  readonly isGenerator: boolean;
  /** Reads `arguments` other than through `...arguments` forwarding. */
  usesArguments: boolean;
  /** `f(...arguments)` forwarding: one node per argument position. */
  argPos: number[] | null;
  /** The class whose member this function is (method, accessor, constructor). */
  readonly ownerClass: Node | null;
  readonly inPackage: boolean;
}

export interface LiteralSite {
  readonly atom: Atom;
  readonly node: Node;
  readonly kind: "object" | "array";
  /** Static keys in creation order; null when a spread or computed key makes them unknown. */
  readonly keys: string[] | null;
  readonly hasAccessor: boolean;
  readonly hasProto: boolean;
  readonly hasComputedKey: boolean;
  readonly spreads: number[];
  readonly inPackage: boolean;
}

export interface Op {
  readonly kind:
    | "read"
    | "write"
    | "computedRead"
    | "computedWrite"
    | "delete"
    | "freeze"
    | "seal"
    | "defineProperty"
    | "setPrototypeOf"
    | "assign"
    | "proxy"
    | "lengthWrite";
  readonly recv: number;
  readonly name: string | null;
  readonly node: Node;
}

export interface CallEdge {
  readonly caller: FunctionInfo | null;
  readonly callee: FunctionInfo;
  readonly inLoop: boolean;
}

export interface ShapeAnalysis {
  readonly atoms: AtomTable;
  readonly nodes: ValueNode[];
  readonly functions: Map<string, FunctionInfo>;
  readonly sites: LiteralSite[];
  readonly ops: Op[];
  readonly calls: CallEdge[];
  readonly escaped: Map<Atom, string>;
  readonly topWriteNames: Map<string, Node>;
  readonly topComputedWrites: Node[];
  /** Fields per atom: name → node id. */
  readonly fields: Map<Atom, Map<string, number>>;
  readonly elements: Map<Atom, number>;
  readonly top: Atom;
  readonly files: readonly ts.SourceFile[];
  readonly packageFiles: number;
  readonly checker: ts.TypeChecker;
  readonly budgetExceeded: boolean;
  readonly steps: number;
  readonly topCause: ReadonlyMap<number, number | string>;
  readonly nodeLabel: ReadonlyMap<number, string>;
}

/** Array.prototype members: other names on an array are own properties. */
const ARRAY_METHODS: ReadonlySet<string> = new Set([
  "at",
  "concat",
  "copyWithin",
  "entries",
  "every",
  "fill",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flat",
  "flatMap",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "map",
  "pop",
  "push",
  "reduce",
  "reduceRight",
  "reverse",
  "shift",
  "slice",
  "some",
  "sort",
  "splice",
  "toLocaleString",
  "toReversed",
  "toSorted",
  "toSpliced",
  "toString",
  "unshift",
  "values",
  "with",
]);
const MAX_STEPS = 20_000_000;

function list<T extends Node>(arr: { readonly nodes: readonly T[] } | undefined): readonly T[] {
  return arr?.nodes ?? [];
}

function isStatic(node: Node): boolean {
  const mods = (node as { modifiers?: { nodes: readonly Node[] } }).modifiers;
  return list(mods).some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
}

function unparen(node: ts.Expression): ts.Expression {
  let n = node;
  for (;;) {
    if (ts.isParenthesizedExpression(n)) n = n.expression;
    else if (ts.isNonNullExpression(n)) n = n.expression;
    else if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
    else return n;
  }
}

function propertyNameText(name: Node): string | null {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (ts.isComputedPropertyName(name)) {
    const e = unparen(name.expression);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isNumericLiteral(e)) return String(Number(e.text));
  }
  return null;
}

function shortFile(fileName: string): string {
  const norm = fileName.split("\\").join("/");
  const nm = norm.lastIndexOf("/node_modules/");
  if (nm >= 0) {
    const rest = norm.slice(nm + "/node_modules/".length).split("/");
    const pkgLen = rest[0]?.startsWith("@") ? 2 : 1;
    const pkg = rest.slice(0, pkgLen).join("/");
    return `${pkg}/${rest[rest.length - 1]}`;
  }
  return norm.slice(norm.lastIndexOf("/") + 1);
}

export function locLabel(node: Node): string {
  const sf = node.getSourceFile();
  const { line } = ts.getLineAndCharacterOfPosition(sf, node.getStart(sf));
  return `${shortFile(sf.fileName)}:${line + 1}`;
}

/** Whether a source file belongs to an opted-in package's JavaScript. */
export function isPackageJsFile(sf: ts.SourceFile): boolean {
  return isJsSourceFile(sf) && npmStaticPackageOfPath(sf.fileName) !== null;
}

function isLoop(node: Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

const LOOP_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  "map",
  "forEach",
  "filter",
  "some",
  "every",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "reduce",
  "reduceRight",
  "flatMap",
  "sort",
]);

export function analyzeShapes(program: ts.Program, checker: ts.TypeChecker): ShapeAnalysis {
  return new Analyzer(program, checker).run();
}

class Analyzer {
  readonly atoms = new AtomTable();
  readonly nodes: ValueNode[] = [];
  readonly functions = new Map<string, FunctionInfo>();
  readonly sites: LiteralSite[] = [];
  private readonly siteAtoms = new Set<Atom>();
  readonly ops: Op[] = [];
  readonly calls: CallEdge[] = [];
  readonly escaped = new Map<Atom, string>();
  readonly topWriteNames = new Map<string, Node>();
  readonly topComputedWrites: Node[] = [];
  readonly fields = new Map<Atom, Map<string, number>>();
  readonly elements = new Map<Atom, number>();
  readonly top: Atom;
  private readonly bindings = new Map<string, number>();
  private readonly exprMemo = new Map<string, number>();
  /** Current analysis context and the function whose clone it is. */
  private ctx = "";
  private ctxRoot: Node | null = null;
  private readonly classInfo = new Map<Node, { initFn: FunctionInfo; staticInit: FunctionInfo }>();
  private readonly boundCalls = new Set<string>();
  private readonly escapedFunctionCalls = new Set<FunctionInfo>();
  private readonly worklist: [number, Atom][] = [];
  private steps = 0;
  private budgetExceeded = false;
  private currentFn: FunctionInfo | null = null;
  private loopDepth = 0;
  private files: ts.SourceFile[] = [];
  private packageFiles = 0;
  private readonly prims = new Map<string, Atom>();
  /** Per call site: the calling function and whether the site is in a loop
   * (constraints fire during solving, after the walk has moved on). */
  private readonly siteCtx = new Map<Node, { caller: FunctionInfo | null; inLoop: boolean }>();
  private forceLoop = false;

  noteSite(site: Node): void {
    if (!this.siteCtx.has(site))
      this.siteCtx.set(site, { caller: this.currentFn, inLoop: this.loopDepth > 0 });
  }

  edgeFor(site: Node, callee: FunctionInfo): void {
    const ctx = this.siteCtx.get(site);
    this.calls.push({
      caller: ctx?.caller ?? null,
      callee,
      inLoop: (ctx?.inLoop ?? false) || this.forceLoop,
    });
  }

  constructor(
    private readonly program: ts.Program,
    private readonly checker: ts.TypeChecker,
  ) {
    this.top = this.atoms.intern("top", () => ({ kind: "top", label: "⊤" }));
  }

  run(): ShapeAnalysis {
    for (const sf of this.program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue;
      const name = sf.fileName.split("\\").join("/");
      const inPackage = isPackageJsFile(sf);
      if (!inPackage && name.includes("/node_modules/")) continue;
      this.files.push(sf);
      if (inPackage) this.packageFiles++;
    }
    for (const sf of this.files) this.checker.prefetchSourceFile(sf);
    for (const sf of this.files) this.moduleBody(sf);
    this.finish();
    return {
      atoms: this.atoms,
      nodes: this.nodes,
      functions: this.functions,
      sites: this.sites,
      ops: this.ops,
      calls: this.calls,
      escaped: this.escaped,
      topWriteNames: this.topWriteNames,
      topComputedWrites: this.topComputedWrites,
      fields: this.fields,
      elements: this.elements,
      top: this.top,
      files: this.files,
      packageFiles: this.packageFiles,
      checker: this.checker,
      budgetExceeded: this.budgetExceeded,
      steps: this.steps,
      topCause: this.topCause,
      nodeLabel: this.nodeLabel,
    };
  }

  // ---- value nodes -------------------------------------------------------

  newNode(): number {
    const id = this.nodes.length;
    this.nodes.push({ id, atoms: new Set(), succ: new Set(), onAtom: [], escapeSink: null });
    return id;
  }

  /** Debugging (SCRIPTC_DEBUG_SHAPES_WHY): where each node's ⊤ came from. */
  readonly topCause = new Map<number, number | string>();
  readonly nodeLabel = new Map<number, string>();
  private cause: number | null = null;
  private readonly traceTop = process.env["SCRIPTC_DEBUG_SHAPES_WHY"] !== undefined;

  add(node: number, atom: Atom): void {
    const n = this.nodes[node]!;
    if (n.atoms.has(atom)) return;
    n.atoms.add(atom);
    if (this.traceTop && atom === this.top && !this.topCause.has(node))
      this.topCause.set(
        node,
        this.cause ??
          (new Error().stack ?? "")
            .split("\n")
            .slice(2, 4)
            .map((l) => l.trim())
            .join(" < "),
      );
    this.worklist.push([node, atom]);
  }

  edge(from: number, to: number): void {
    if (from === to) return;
    const n = this.nodes[from]!;
    if (n.succ.has(to)) return;
    n.succ.add(to);
    const saved = this.cause;
    this.cause = from;
    for (const a of n.atoms) this.add(to, a);
    this.cause = saved;
  }

  on(node: number, fn: (atom: Atom) => void): void {
    const n = this.nodes[node]!;
    n.onAtom.push(fn);
    for (const a of [...n.atoms]) fn(a);
  }

  sink(node: number, reason: string): void {
    const n = this.nodes[node]!;
    if (n.escapeSink !== null) return;
    n.escapeSink = reason;
    for (const a of [...n.atoms]) this.escape(a, reason);
  }

  constNode(atom: Atom): number {
    const n = this.newNode();
    this.add(n, atom);
    return n;
  }

  prim(name: string): Atom {
    let a = this.prims.get(name);
    if (a === undefined) {
      a = this.atoms.intern(`prim:${name}`, () => ({ kind: "prim", label: name }));
      this.prims.set(name, a);
    }
    return a;
  }

  builtin(path: string, receiver?: Atom): Atom {
    const key = receiver === undefined ? `builtin:${path}` : `builtin:${path}@${receiver.id}`;
    return this.atoms.intern(key, () => ({ kind: "builtin", label: path, path, receiver }));
  }

  solve(): void {
    while (this.worklist.length > 0) {
      if (++this.steps > MAX_STEPS) {
        this.budgetExceeded = true;
        return;
      }
      const [id, atom] = this.worklist.pop()!;
      const n = this.nodes[id]!;
      this.cause = id;
      for (const s of n.succ) this.add(s, atom);
      this.cause = null;
      for (const f of n.onAtom) f(atom);
      if (n.escapeSink !== null) this.escape(atom, n.escapeSink);
    }
  }

  // ---- heap ----------------------------------------------------------------

  field(atom: Atom, name: string): number {
    let m = this.fields.get(atom);
    if (m === undefined) {
      m = new Map();
      this.fields.set(atom, m);
    }
    let id = m.get(name);
    if (id === undefined) {
      id = this.newNode();
      m.set(name, id);
      if (this.traceTop) this.nodeLabel.set(id, `${atom.label}.${name}`);
      if (name === "*") {
        for (const dst of this.unknownKeyReaders.get(atom) ?? []) this.edge(id, dst);
        this.unknownKeyReaders.delete(atom);
      }
      const reason = this.escaped.get(atom);
      if (reason !== undefined) {
        this.sink(id, reason);
        if (this.topComputedWrites.length > 0 || this.topWriteNames.has(name))
          this.add(id, this.top);
      }
    }
    return id;
  }

  element(atom: Atom): number {
    let id = this.elements.get(atom);
    if (id === undefined) {
      id = this.newNode();
      this.elements.set(atom, id);
      const reason = this.escaped.get(atom);
      if (reason !== undefined) {
        this.sink(id, reason);
        if (this.topComputedWrites.length > 0) this.add(id, this.top);
      }
    }
    return id;
  }

  escape(atom: Atom, reason: string): void {
    if (atom.kind === "prim" || atom.kind === "top") return;
    if (atom.kind === "builtin" && atom.receiver === undefined) return;
    if (this.escaped.has(atom)) return;
    this.escaped.set(atom, reason);
    const via = `via ${atom.label}`;
    const fm = this.fields.get(atom);
    if (fm !== undefined) {
      for (const [name, id] of fm) {
        this.sink(id, via);
        if (this.topComputedWrites.length > 0 || this.topWriteNames.has(name))
          this.add(id, this.top);
      }
    }
    const el = this.elements.get(atom);
    if (el !== undefined) {
      this.sink(el, via);
      if (this.topComputedWrites.length > 0) this.add(el, this.top);
    }
    if (atom.receiver !== undefined) this.escape(atom.receiver, via);
    if (atom.kind === "function") {
      const info = this.infoOfAtom(atom);
      if (info !== undefined) this.escapeFunction(info, via);
    }
    if ((atom.kind === "instance" || atom.kind === "class") && atom.node !== undefined) {
      // Unknown code may call any member with any arguments.
      for (const member of this.classMembers(atom.node, atom.kind === "class")) {
        const info = this.functionInfo(member, this.ownerOf(member), this.receiverCtx(atom));
        this.add(info.thisNode, atom);
        this.escapeFunction(info, via);
      }
    }
    if (atom.kind === "promise") this.sink(this.field(atom, "value"), via);
  }

  /** A function unknown code may call: ⊤ arguments and receiver; its
   * results escape. */
  escapeFunction(info: FunctionInfo, reason: string): void {
    if (this.escapedFunctionCalls.has(info)) return;
    this.escapedFunctionCalls.add(info);
    this.activate(info);
    for (const p of info.params) this.add(p, this.top);
    if (!info.isArrow && info.ownerClass === null) this.add(info.thisNode, this.top);
    this.sink(info.ret, reason);
  }

  /** Property names that untyped code writes on receivers that may be ⊤ (census). */
  noteTopWrite(name: string | null, node: Node): void {
    if (name === null) {
      const first = this.topComputedWrites.length === 0;
      this.topComputedWrites.push(node);
      if (first) {
        for (const atom of [...this.escaped.keys()]) {
          for (const id of (this.fields.get(atom) ?? new Map<string, number>()).values())
            this.add(id, this.top);
          const el = this.elements.get(atom);
          if (el !== undefined) this.add(el, this.top);
        }
      }
      return;
    }
    if (this.topWriteNames.has(name)) return;
    this.topWriteNames.set(name, node);
    for (const atom of [...this.escaped.keys()]) {
      const id = this.fields.get(atom)?.get(name);
      if (id !== undefined) this.add(id, this.top);
    }
  }

  // ---- classes ---------------------------------------------------------------

  /** The base class declaration of `decl`, via the checker; null at a
   * builtin base or none; undefined when unresolved. */
  baseClass(decl: Node): Node | null | undefined {
    const heritage = list((decl as ts.ClassLikeDeclaration).heritageClauses).find(
      (c) => c.token === ts.SyntaxKind.ExtendsKeyword,
    )?.types?.nodes[0];
    if (heritage === undefined) return null;
    const e = unparen(heritage.expression);
    if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return undefined;
    let d = this.resolve(ts.isIdentifier(e) ? e : e.name);
    // `var C = class C { … }` (bundler output)
    if (
      d !== undefined &&
      ts.isVariableDeclaration(d) &&
      d.initializer !== undefined &&
      ts.isClassExpression(unparen(d.initializer))
    )
      d = unparen(d.initializer);
    if (d !== undefined && ts.isClassLikeDeclaration(d)) return d;
    if (d !== undefined && d.getSourceFile().isDeclarationFile) return null;
    return undefined;
  }

  classChain(decl: Node): Node[] {
    const out: Node[] = [];
    let cur: Node | null | undefined = decl;
    while (cur && out.length < 64 && !out.includes(cur)) {
      out.push(cur);
      cur = this.baseClass(cur);
    }
    return out;
  }

  /** Method, accessor and constructor declarations of a class chain. */
  classMembers(decl: Node, statics: boolean): Node[] {
    const out: Node[] = [];
    for (const c of this.classChain(decl)) {
      for (const m of list((c as ts.ClassLikeDeclaration).members)) {
        if (isStatic(m) !== statics) continue;
        if (
          ts.isMethodDeclaration(m) ||
          ts.isGetAccessorDeclaration(m) ||
          ts.isSetAccessorDeclaration(m)
        )
          out.push(m);
        else if (ts.isPropertyDeclaration(m) && m.initializer !== undefined) {
          const init = unparen(m.initializer);
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) out.push(init);
        }
      }
    }
    return out;
  }

  lookupMember(
    decl: Node,
    name: string,
    statics: boolean,
  ): {
    kind: "method" | "getter" | "setter" | "both";
    get?: Node;
    set?: Node;
    method?: Node;
  } | null {
    for (const c of this.classChain(decl)) {
      let get: Node | undefined;
      let set: Node | undefined;
      for (const m of list((c as ts.ClassLikeDeclaration).members)) {
        if (isStatic(m) !== statics) continue;
        const mn = (m as { name?: Node }).name;
        if (mn === undefined || propertyNameText(mn) !== name) continue;
        if (ts.isMethodDeclaration(m)) return { kind: "method", method: m };
        if (ts.isGetAccessorDeclaration(m)) get = m;
        if (ts.isSetAccessorDeclaration(m)) set = m;
        if (ts.isPropertyDeclaration(m)) return null; // an own field: data
      }
      if (get || set)
        return {
          kind: get && set ? "both" : get ? "getter" : "setter",
          ...(get ? { get } : {}),
          ...(set ? { set } : {}),
        };
    }
    return null;
  }

  // ---- symbols -----------------------------------------------------------------

  resolve(id: Node): Node | undefined {
    let sym = this.checker.getSymbolAtLocation(id);
    if (sym === undefined) return undefined;
    if (sym.flags & ts.SymbolFlags.Alias) {
      try {
        sym = this.checker.getAliasedSymbol(sym);
      } catch {
        return undefined;
      }
    }
    return sym.valueDeclaration ?? sym.declarations[0];
  }

  binding(decl: Node): number {
    const key = this.ctxKey(decl);
    let id = this.bindings.get(key);
    if (id === undefined) {
      id = this.newNode();
      this.bindings.set(key, id);
      if (this.traceTop)
        this.nodeLabel.set(
          id,
          `binding ${(decl as { name?: { text?: string } }).name?.text ?? "?"}@${locLabel(decl)}${this.ctx !== "" ? ` [${this.ctx}]` : ""}`,
        );
    }
    return id;
  }

  /** Bindings and expressions inside the function being cloned belong to
   * the clone's context; everything else to the default context. */
  ctxKey(node: Node): string {
    const root = this.ctxRoot;
    const inside =
      root !== null &&
      node.getSourceFile() === root.getSourceFile() &&
      node.pos >= root.pos &&
      node.end <= root.end;
    return `${inside ? this.ctx : ""}|${this.nodeKey(node)}`;
  }

  receiverCtx(atom: Atom): string {
    return atom.kind === "instance" || atom.kind === "class" ? `C${atom.id}` : "";
  }

  infoOfAtom(atom: Atom): FunctionInfo | undefined {
    if (atom.node === undefined) return undefined;
    return this.functions.get(`${atom.ctx ?? ""}|${this.nodeKey(atom.node)}`);
  }

  // ---- functions ---------------------------------------------------------------

  functionInfo(node: Node, ownerClass: Node | null, ctxArg = ""): FunctionInfo {
    // A nested closure walked inside a clone shares the clone's context.
    const inherit =
      ctxArg === "" &&
      this.ctxRoot !== null &&
      node.getSourceFile() === this.ctxRoot.getSourceFile() &&
      node.pos >= this.ctxRoot.pos &&
      node.end <= this.ctxRoot.end;
    const ctx = ctxArg !== "" ? ctxArg : inherit ? this.ctx : "";
    const root = ctxArg !== "" ? node : inherit ? this.ctxRoot : null;
    const fkey = `${ctx}|${this.nodeKey(node)}`;
    const existing = this.functions.get(fkey);
    if (existing !== undefined) return existing;
    const savedCtx = this.ctx;
    const savedRoot = this.ctxRoot;
    this.ctx = ctx;
    this.ctxRoot = root;
    const fn = node as ts.FunctionLikeDeclaration;
    const isArrow = ts.isArrowFunction(node);
    const params: number[] = [];
    let rest = -1;
    for (const p of list(fn.parameters)) {
      const id = this.binding(p);
      if (p.dotDotDotToken !== undefined) rest = params.length;
      params.push(id);
    }
    const mods = list((fn as { modifiers?: { nodes: readonly Node[] } }).modifiers);
    const sf = node.getSourceFile();
    const nameNode = (fn as { name?: Node }).name;
    const name = nameNode !== undefined ? (propertyNameText(nameNode) ?? "<computed>") : null;
    const owner = ownerClass !== null ? this.className(ownerClass) : null;
    const label = `${owner !== null ? `${owner}.` : ""}${name ?? (ts.isConstructorDeclaration(node) ? "constructor" : "<fn>")}@${locLabel(node)}`;
    const info: FunctionInfo = {
      node,
      ctx,
      root,
      walked: false,
      label: ctx === "" ? label : `${label} [${this.ctxLabel(ctx)}]`,
      params,
      rest,
      thisNode: isArrow && this.currentFn !== null ? this.currentFn.thisNode : this.newNode(),
      ret: this.newNode(),
      isArrow,
      isAsync: mods.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
      isGenerator: (fn as { asteriskToken?: Node }).asteriskToken !== undefined,
      usesArguments: false,
      argPos: null,
      ownerClass,
      inPackage: isPackageJsFile(sf),
    };
    this.functions.set(fkey, info);
    this.ctx = savedCtx;
    this.ctxRoot = savedRoot;
    return info;
  }

  /** Walks a function's body the first time it can run. */
  activate(info: FunctionInfo): void {
    if (info.walked) return;
    info.walked = true;
    if (ts.isSourceFile(info.node) || ts.isClassLikeDeclaration(info.node)) return;
    const fn = info.node as ts.FunctionLikeDeclaration;
    const savedCtx = this.ctx;
    const savedRoot = this.ctxRoot;
    const saved = this.currentFn;
    const savedLoop = this.loopDepth;
    this.ctx = info.ctx;
    this.ctxRoot = info.root;
    this.currentFn = info;
    this.loopDepth = 0;
    for (const p of list(fn.parameters)) {
      if (p.initializer !== undefined) this.edge(this.expr(p.initializer), this.binding(p));
      if (p.dotDotDotToken !== undefined) {
        const arr = this.atoms.intern(`rest:${this.nodes.length}`, () => ({
          kind: "array",
          label: `rest@${locLabel(p)}`,
          node: p,
        }));
        this.add(this.binding(p), arr);
      }
      this.bindPattern(p.name, this.binding(p));
    }
    const body = fn.body;
    if (body !== undefined) {
      if (ts.isBlock(body)) this.stmts(list(body.statements));
      else this.edge(this.expr(body as ts.Expression), info.ret);
    }
    this.currentFn = saved;
    this.loopDepth = savedLoop;
    this.ctx = savedCtx;
    this.ctxRoot = savedRoot;
    if (info.usesArguments) {
      for (const p of info.params) this.add(p, this.top);
    }
  }

  /** The atom of a function node (memoized by its info). */
  fnAtom(node: Node, ownerClass: Node | null, ctx = ""): Atom {
    const info = this.functionInfo(node, ownerClass, ctx);
    return this.atoms.intern(`fn:${info.ret}`, () => ({
      kind: "function",
      label: info.label,
      node,
      ctx: info.ctx,
    }));
  }

  ctxLabel(ctx: string): string {
    if (ctx.startsWith("C")) return `this=${this.atoms.atoms[Number(ctx.slice(1))]?.label ?? ctx}`;
    return ctx;
  }

  className(decl: Node): string {
    const own = (decl as ts.ClassLikeDeclaration).name?.text;
    if (own !== undefined) return own;
    const p = decl.parent;
    if (p !== undefined && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name))
      return p.name.text;
    return `<class@${locLabel(decl)}>`;
  }

  classAtoms(decl: Node): { cls: Atom; inst: Atom } {
    const name = this.className(decl);
    const cls = this.atoms.intern(`class:${this.nodeKey(decl)}`, () => ({
      kind: "class",
      label: `class ${name}`,
      node: decl,
    }));
    const inst = this.atoms.intern(`inst:${this.nodeKey(decl)}`, () => ({
      kind: "instance",
      label: name,
      node: decl,
    }));
    this.ensureClass(decl);
    return { cls, inst };
  }

  private readonly nodeKeys = new Map<Node, number>();
  nodeKey(node: Node): number {
    let k = this.nodeKeys.get(node);
    if (k === undefined) {
      k = this.nodeKeys.size;
      this.nodeKeys.set(node, k);
    }
    return k;
  }

  /** Registers a class: member functions, field initializers (as a pseudo
   * function run at construction) and static initializers. */
  ensureClass(decl: Node): { initFn: FunctionInfo; staticInit: FunctionInfo } {
    const existing = this.classInfo.get(decl);
    if (existing !== undefined) return existing;
    const c = decl as ts.ClassLikeDeclaration;
    const label = this.className(decl);
    const mk = (suffix: string): FunctionInfo => ({
      node: decl,
      ctx: "",
      root: null,
      walked: true,
      label: `${label}.${suffix}@${locLabel(decl)}`,
      params: [],
      rest: -1,
      thisNode: this.newNode(),
      ret: this.newNode(),
      isArrow: false,
      isAsync: false,
      isGenerator: false,
      usesArguments: false,
      argPos: null,
      ownerClass: decl,
      inPackage: isPackageJsFile(decl.getSourceFile()),
    });
    const entry = { initFn: mk("<fields>"), staticInit: mk("<static>") };
    this.classInfo.set(decl, entry);
    const cls = this.atoms.intern(`class:${this.nodeKey(decl)}`, () => ({
      kind: "class",
      label: `class ${label}`,
      node: decl,
    }));
    this.add(entry.staticInit.thisNode, cls);
    const saved = this.currentFn;
    for (const m of list(c.members)) {
      const statics = isStatic(m);
      if (
        ts.isMethodDeclaration(m) ||
        ts.isGetAccessorDeclaration(m) ||
        ts.isSetAccessorDeclaration(m) ||
        ts.isConstructorDeclaration(m)
      ) {
        continue;
      }
      if (ts.isPropertyDeclaration(m)) {
        const name = propertyNameText(m.name);
        const init = statics ? entry.staticInit : entry.initFn;
        this.currentFn = init;
        const value =
          m.initializer !== undefined
            ? this.exprIn(m.initializer, decl)
            : this.constNode(this.prim("undefined"));
        if (name !== null) this.storeConstraint(init.thisNode, name, value, m);
        continue;
      }
      if (ts.isClassStaticBlockDeclaration(m)) {
        this.currentFn = entry.staticInit;
        this.stmts(list(m.body.statements));
      }
    }
    this.currentFn = saved;
    return entry;
  }

  /** An initializer expression: arrow functions in field initializers take
   * the instance as `this` and belong to the class. */
  exprIn(e: ts.Expression, ownerClass: Node): number {
    const u = unparen(e);
    if (ts.isArrowFunction(u) || ts.isFunctionExpression(u)) {
      const n = this.newNode();
      this.add(n, this.fnAtom(u, ts.isArrowFunction(u) ? null : ownerClass));
      return n;
    }
    return this.expr(e);
  }

  /** `new C(args)` on a class atom: the instance, the field initializers of
   * every class in the chain, and the constructor (or the implicit one). */
  construct(
    decl: Node,
    args: number[],
    spread: boolean,
    dst: number,
    site: Node,
    inst?: Atom,
  ): void {
    const atoms = this.classAtoms(decl);
    const instance = inst ?? atoms.inst;
    this.add(dst, instance);
    this.callConstructorChain(decl, instance, args, spread, site);
  }

  callConstructorChain(
    decl: Node,
    instance: Atom,
    args: number[],
    spread: boolean,
    site: Node,
  ): void {
    const key = `ctor:${this.nodeKey(decl)}:${instance.id}:${this.nodeKey(site)}`;
    if (this.boundCalls.has(key)) return;
    this.boundCalls.add(key);
    const entry = this.ensureClass(decl);
    this.add(entry.initFn.thisNode, instance);
    const ctor = list((decl as ts.ClassLikeDeclaration).members).find((m) =>
      ts.isConstructorDeclaration(m),
    );
    if (ctor !== undefined) {
      const info = this.functionInfo(ctor, decl, this.receiverCtx(instance));
      this.activate(info);
      this.add(info.thisNode, instance);
      this.bindArgs(info, args, spread);
      this.edgeFor(site, info);
      return;
    }
    const base = this.baseClass(decl);
    if (base) this.callConstructorChain(base, instance, args, spread, site);
  }

  bindArgs(info: FunctionInfo, args: number[], spread: boolean): void {
    if (info.argPos !== null) {
      for (let i = 0; i < info.argPos.length; i++) {
        if (spread || i >= info.argPos.length - 1) {
          for (const a of args.slice(i)) this.edge(a, info.argPos[i]!);
          if (spread) this.add(info.argPos[i]!, this.top);
        } else if (i < args.length) this.edge(args[i]!, info.argPos[i]!);
        else this.add(info.argPos[i]!, this.prim("undefined"));
      }
    }
    if (spread) {
      for (const p of info.params) this.add(p, this.top);
      for (const a of args) this.sink(a, `spread into ${info.label}`);
      return;
    }
    for (let i = 0; i < info.params.length; i++) {
      if (i === info.rest) {
        const restAtoms = [...this.nodes[info.params[i]!]!.atoms];
        for (const ra of restAtoms)
          for (let j = i; j < args.length; j++) this.edge(args[j]!, this.element(ra));
        break;
      }
      if (i < args.length) this.edge(args[i]!, info.params[i]!);
      else this.add(info.params[i]!, this.prim("undefined"));
    }
  }

  /** Call of a function atom with a receiver node. */
  callFunction(
    info: FunctionInfo,
    thisNode: number | null,
    args: number[],
    spread: boolean,
    dst: number,
    site: Node,
  ): void {
    // `() => Object.create(null)` helpers: each call site gets its own
    // dictionary, as if the helper were inlined.
    if (this.isFactory(info.node)) {
      const d = this.atoms.intern(`dict:${this.nodeKey(site)}`, () => ({
        kind: "dictionary",
        label: `Object.create@${locLabel(site)}`,
        node: site,
      }));
      this.add(dst, d);
      return;
    }
    this.activate(info);
    const fnNode = info.node;
    const key = `call:${info.ctx}|${this.nodeKey(fnNode)}:${this.nodeKey(site)}:${thisNode ?? -1}:${dst}`;
    if (this.boundCalls.has(key)) return;
    this.boundCalls.add(key);
    if (thisNode !== null && !info.isArrow) this.edge(thisNode, info.thisNode);
    this.bindArgs(info, args, spread);
    if (info.isAsync) {
      const p = this.promiseAtom(fnNode, `async ${info.label}`);
      this.awaitInto(info.ret, this.field(p, "value"));
      this.add(dst, p);
    } else if (info.isGenerator) {
      this.add(dst, this.top);
    } else this.edge(info.ret, dst);
    this.edgeFor(site, info);
  }

  private readonly factories = new Map<Node, boolean>();
  isFactory(node: Node): boolean {
    let r = this.factories.get(node);
    if (r === undefined) {
      r = false;
      const fn = node as ts.FunctionLikeDeclaration;
      let e: Node | undefined = fn.body;
      if (e !== undefined && ts.isBlock(e)) {
        const st = e.statements.nodes;
        e = st.length === 1 && ts.isReturnStatement(st[0]!) ? st[0]!.expression : undefined;
      }
      if (e !== undefined && !ts.isSourceFile(node)) {
        const u = unparen(e as ts.Expression);
        r =
          ts.isCallExpression(u) &&
          u.expression.getText() === "Object.create" &&
          u.arguments.nodes.length === 1 &&
          u.arguments.nodes[0]!.kind === ts.SyntaxKind.NullKeyword;
      }
      this.factories.set(node, r);
    }
    return r;
  }

  promiseAtom(site: Node, label: string): Atom {
    return this.atoms.intern(`promise:${this.nodeKey(site)}`, () => ({
      kind: "promise",
      label: `Promise@${label}`,
      node: site,
    }));
  }

  /** dst ⊇ awaited(src). */
  awaitInto(src: number, dst: number): void {
    this.on(src, (a) => {
      if (a.kind === "promise") this.edge(this.field(a, "value"), dst);
      else this.add(dst, a);
    });
  }

  syntheticArray(site: Node, tag: string): Atom {
    return this.atoms.intern(`arr:${tag}:${this.nodeKey(site)}`, () => ({
      kind: "array",
      label: `${tag}[]@${locLabel(site)}`,
      node: site,
    }));
  }

  // ---- statements ----------------------------------------------------------------

  moduleBody(sf: ts.SourceFile): void {
    const info: FunctionInfo = {
      node: sf,
      ctx: "",
      root: null,
      walked: true,
      label: `<module ${shortFile(sf.fileName)}>`,
      params: [],
      rest: -1,
      thisNode: this.constNode(this.prim("undefined")),
      ret: this.newNode(),
      isArrow: false,
      isAsync: false,
      isGenerator: false,
      usesArguments: false,
      argPos: null,
      ownerClass: null,
      inPackage: isPackageJsFile(sf),
    };
    this.functions.set(`|${this.nodeKey(sf)}`, info);
    this.currentFn = info;
    this.stmts(list(sf.statements));
    this.currentFn = null;
  }

  stmts(stmts: readonly Node[]): void {
    for (const s of stmts) this.stmt(s);
  }

  stmt(s: Node): void {
    if (ts.isVariableStatement(s)) {
      for (const d of list(s.declarationList.declarations)) this.varDecl(d);
      return;
    }
    if (ts.isExpressionStatement(s)) {
      this.expr(s.expression);
      return;
    }
    if (ts.isReturnStatement(s)) {
      if (s.expression !== undefined && this.currentFn !== null)
        this.edge(this.expr(s.expression), this.currentFn.ret);
      return;
    }
    if (ts.isFunctionDeclaration(s)) {
      const b = this.binding(s);
      const saved = this.currentFn;
      this.currentFn = null;
      this.add(b, this.fnAtom(s, null));
      this.currentFn = saved;
      return;
    }
    if (ts.isClassDeclaration(s)) {
      const b = this.binding(s);
      this.add(b, this.classAtoms(s).cls);
      return;
    }
    if (isLoop(s)) {
      if (ts.isForOfStatement(s) || ts.isForInStatement(s)) {
        const src = this.expr(s.expression);
        const target = this.newNode();
        if (ts.isForInStatement(s)) this.add(target, this.prim("string"));
        else this.iterateInto(src, target, s);
        const init = s.initializer;
        if (ts.isVariableDeclarationList(init)) {
          for (const d of list(init.declarations)) {
            this.edge(target, this.binding(d));
            this.bindPattern(d.name, this.binding(d));
          }
        } else this.assignTo(init as ts.Expression, target);
      }
      this.loopDepth++;
      if (ts.isForStatement(s)) {
        if (s.initializer !== undefined) {
          if (ts.isVariableDeclarationList(s.initializer))
            for (const d of list(s.initializer.declarations)) this.varDecl(d);
          else this.expr(s.initializer as ts.Expression);
        }
        if (s.condition !== undefined) this.expr(s.condition);
        if (s.incrementor !== undefined) this.expr(s.incrementor);
      }
      if (ts.isWhileStatement(s) || ts.isDoStatement(s)) this.expr(s.expression);
      const body = (s as { statement?: Node }).statement;
      if (body !== undefined) this.stmt(body);
      this.loopDepth--;
      return;
    }
    if (ts.isTryStatement(s)) {
      this.stmts(list(s.tryBlock.statements));
      if (s.catchClause !== undefined) {
        const v = s.catchClause.variableDeclaration;
        if (v !== undefined) {
          this.add(this.binding(v), this.top);
          this.bindPattern(v.name, this.binding(v));
        }
        this.stmts(list(s.catchClause.block.statements));
      }
      if (s.finallyBlock !== undefined) this.stmts(list(s.finallyBlock.statements));
      return;
    }
    if (ts.isThrowStatement(s)) {
      this.sink(this.expr(s.expression), `thrown at ${locLabel(s)}`);
      return;
    }
    if (
      ts.isImportDeclaration(s) ||
      ts.isExportDeclaration(s) ||
      ts.isInterfaceDeclaration(s) ||
      ts.isTypeAliasDeclaration(s)
    )
      return;
    if (ts.isExportAssignment(s)) {
      this.expr(s.expression);
      return;
    }
    // Blocks, ifs, switches, labels: walk children, evaluating expressions.
    ts.forEachChild(s, (child) => {
      if (ts.isExpression(child)) this.expr(child);
      else this.stmt(child);
      return undefined;
    });
  }

  varDecl(d: ts.VariableDeclaration): void {
    const b = this.binding(d);
    if (d.initializer !== undefined) this.edge(this.expr(d.initializer), b);
    this.bindPattern(d.name, b);
  }

  /** Destructuring: binding elements read from the source node. */
  bindPattern(name: Node, src: number): void {
    if (ts.isIdentifier(name)) return;
    if (ts.isObjectBindingPattern(name)) {
      for (const el of list(name.elements)) {
        const b = this.binding(el);
        if (el.dotDotDotToken !== undefined) {
          this.add(b, this.top);
          continue;
        }
        const keyNode = el.propertyName ?? el.name;
        const key = keyNode !== undefined ? propertyNameText(keyNode) : null;
        if (key !== null) this.loadConstraint(src, key, b, el);
        else this.add(b, this.top);
        if (el.initializer !== undefined) this.edge(this.expr(el.initializer), b);
        if (el.name !== undefined) this.bindPattern(el.name, b);
      }
      return;
    }
    if (ts.isArrayBindingPattern(name)) {
      let i = 0;
      for (const el of list(name.elements)) {
        if (ts.isBindingElement(el)) {
          const b = this.binding(el);
          if (el.dotDotDotToken !== undefined) this.add(b, this.top);
          else this.iterateInto(src, b, el, i);
          if (el.initializer !== undefined) this.edge(this.expr(el.initializer), b);
          if (el.name !== undefined) this.bindPattern(el.name, b);
        }
        i++;
      }
    }
  }

  /** Element values of an iterable. */
  iterateInto(src: number, dst: number, site: Node, _index?: number): void {
    this.on(src, (a) => {
      if (a.kind === "array" || a.kind === "collection") this.edge(this.element(a), dst);
      else if (a.kind === "prim" && a.label === "string") this.add(dst, this.prim("string"));
      else if (a.kind === "prim" || a.kind === "object" || a.kind === "dictionary") {
        /* not iterable (a TypeError): no value. Literals with a
           Symbol.iterator member have a computed key; they are G sites. */
      } else {
        this.add(dst, this.top);
        if (a.kind !== "top") this.escape(a, `iterated at ${locLabel(site)}`);
      }
    });
  }

  // ---- expressions ---------------------------------------------------------------

  expr(e: ts.Expression): number {
    const key = this.ctxKey(e);
    const memo = this.exprMemo.get(key);
    if (memo !== undefined) return memo;
    const id = this.exprUncached(e);
    this.exprMemo.set(key, id);
    if (this.traceTop && !this.nodeLabel.has(id))
      this.nodeLabel.set(
        id,
        `expr ${e.getText().slice(0, 40).replace(/\s+/g, " ")}@${locLabel(e)}`,
      );
    return id;
  }

  private exprUncached(e: ts.Expression): number {
    const u = unparen(e);
    if (u !== e) return this.expr(u);
    switch (e.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateExpression:
        if (ts.isTemplateExpression(e))
          for (const span of list(e.templateSpans)) this.expr(span.expression);
        return this.constNode(this.prim("string"));
      case ts.SyntaxKind.NumericLiteral:
        return this.constNode(this.prim("number"));
      case ts.SyntaxKind.BigIntLiteral:
        return this.constNode(this.prim("bigint"));
      case ts.SyntaxKind.TrueKeyword:
      case ts.SyntaxKind.FalseKeyword:
        return this.constNode(this.prim("boolean"));
      case ts.SyntaxKind.NullKeyword:
        return this.constNode(this.prim("null"));
      case ts.SyntaxKind.RegularExpressionLiteral:
        return this.constNode(this.builtin("RegExp.instance"));
      case ts.SyntaxKind.ThisKeyword:
        return this.currentFn !== null
          ? this.currentFn.thisNode
          : this.constNode(this.prim("undefined"));
      case ts.SyntaxKind.SuperKeyword:
        return this.constNode(this.top);
    }
    if (ts.isIdentifier(e)) return this.identifier(e);
    if (ts.isObjectLiteralExpression(e)) return this.objectLiteral(e);
    if (ts.isArrayLiteralExpression(e)) return this.arrayLiteral(e);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      const n = this.newNode();
      this.add(n, this.fnAtom(e, null));
      if (ts.isFunctionExpression(e) && e.name !== undefined)
        this.add(this.binding(e), this.fnAtom(e, null));
      return n;
    }
    if (ts.isClassExpression(e)) {
      const n = this.newNode();
      this.add(n, this.classAtoms(e).cls);
      return n;
    }
    if (ts.isPropertyAccessExpression(e)) {
      this.noteSite(e);
      const recv = this.expr(e.expression);
      const name = e.name.text;
      const dst = this.newNode();
      this.loadConstraint(recv, name, dst, e);
      this.ops.push({ kind: "read", recv, name, node: e });
      return dst;
    }
    if (ts.isElementAccessExpression(e)) {
      const recv = this.expr(e.expression);
      const key = unparen(e.argumentExpression);
      const dst = this.newNode();
      const name =
        ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key) ? key.text : null;
      if (name !== null) {
        this.loadConstraint(recv, name, dst, e);
        this.ops.push({ kind: "read", recv, name, node: e });
      } else {
        this.expr(e.argumentExpression);
        this.computedLoad(recv, dst, e);
        this.ops.push({ kind: "computedRead", recv, name: null, node: e });
      }
      return dst;
    }
    if (ts.isCallExpression(e)) return this.call(e);
    if (ts.isNewExpression(e)) return this.newExpr(e);
    if (ts.isBinaryExpression(e)) return this.binary(e);
    if (ts.isConditionalExpression(e)) {
      this.expr(e.condition);
      const n = this.newNode();
      this.edge(this.expr(e.whenTrue), n);
      this.edge(this.expr(e.whenFalse), n);
      return n;
    }
    if (ts.isAwaitExpression(e)) {
      const n = this.newNode();
      this.awaitInto(this.expr(e.expression), n);
      return n;
    }
    if (ts.isTypeOfExpression(e)) {
      this.expr(e.expression);
      return this.constNode(this.prim("string"));
    }
    if (ts.isVoidExpression(e)) {
      this.expr(e.expression);
      return this.constNode(this.prim("undefined"));
    }
    if (ts.isDeleteExpression(e)) {
      const target = unparen(e.expression);
      if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
        const recv = this.expr(target.expression);
        const name = ts.isPropertyAccessExpression(target) ? target.name.text : null;
        this.ops.push({ kind: "delete", recv, name, node: e });
      }
      return this.constNode(this.prim("boolean"));
    }
    if (ts.isPrefixUnaryExpression(e) || ts.isPostfixUnaryExpression(e)) {
      const operand = e.operand;
      this.expr(operand);
      if (
        e.operator === ts.SyntaxKind.PlusPlusToken ||
        e.operator === ts.SyntaxKind.MinusMinusToken
      )
        this.assignTo(operand, this.constNode(this.prim("number")));
      if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken)
        return this.constNode(this.prim("boolean"));
      return this.constNode(this.prim("number"));
    }
    if (ts.isSpreadElement(e)) return this.expr(e.expression);
    if (ts.isTaggedTemplateExpression(e)) return this.taggedTemplate(e);
    if (ts.isYieldExpression(e)) {
      if (e.expression !== undefined)
        this.sink(this.expr(e.expression), `yielded at ${locLabel(e)}`);
      return this.constNode(this.top);
    }
    if (ts.isMetaProperty(e)) return this.constNode(this.top);
    // Anything else: evaluate children, answer ⊤.
    ts.forEachChild(e, (child) => {
      if (ts.isExpression(child)) this.expr(child);
      return undefined;
    });
    return this.constNode(this.top);
  }

  identifier(id: ts.Identifier): number {
    if (id.text === "undefined") return this.constNode(this.prim("undefined"));
    if (id.text === "arguments") {
      const fn = this.enclosingNonArrow();
      if (fn !== null) {
        const parent = id.parent;
        const forwarding = parent !== undefined && ts.isSpreadElement(parent);
        if (!forwarding) fn.usesArguments = true;
        const arr = this.syntheticArray(id, "arguments");
        for (const p of fn.params) this.edge(p, this.element(arr));
        return this.constNode(arr);
      }
    }
    const decl = this.resolve(id);
    if (decl === undefined) return this.globalNode(id.text);
    if (decl.getSourceFile().isDeclarationFile) return this.globalNode(id.text);
    if (!this.files.includes(decl.getSourceFile())) return this.constNode(this.top);
    if (ts.isFunctionDeclaration(decl)) {
      const b = this.binding(decl);
      const saved = this.currentFn;
      this.currentFn = null;
      this.add(b, this.fnAtom(decl, null));
      this.currentFn = saved;
      return b;
    }
    if (ts.isClassDeclaration(decl) || ts.isClassExpression(decl)) {
      const b = this.binding(decl);
      this.add(b, this.classAtoms(decl).cls);
      return b;
    }
    if (ts.isFunctionExpression(decl)) return this.binding(decl);
    if (
      ts.isImportSpecifier(decl) ||
      ts.isImportClause(decl) ||
      ts.isNamespaceImport(decl) ||
      ts.isImportEqualsDeclaration(decl)
    )
      return this.constNode(this.top);
    if (ts.isSourceFile(decl) || ts.isModuleDeclaration(decl)) return this.namespaceNode(decl);
    return this.narrowed(id, decl, this.binding(decl));
  }

  /** Flow narrowing at guarded references (S1 handles the guards hot code
   * uses: `x instanceof C` and calls of predicate functions whose body is
   * `… && x instanceof C`, in the true arm of an `if`, `?:` or `&&`). The
   * narrowed value keeps the guard's class arms and ⊤. */
  narrowed(id: ts.Identifier, decl: Node, value: number): number {
    let child: Node = id;
    let p = id.parent;
    while (p !== undefined && !ts.isFunctionLike(p) && !ts.isSourceFile(p)) {
      let cond: ts.Expression | undefined;
      if (ts.isIfStatement(p) && p.thenStatement === child) cond = p.expression;
      else if (ts.isConditionalExpression(p) && p.whenTrue === child) cond = p.condition;
      else if (
        ts.isBinaryExpression(p) &&
        p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        p.right === child
      )
        cond = p.left;
      if (cond !== undefined) {
        const cls = this.guardClass(cond, decl);
        if (cls !== null) {
          const out = this.newNode();
          this.on(value, (a) => {
            if (a.kind === "top") this.add(out, a);
            else if (
              cls === "Promise"
                ? a.kind === "promise"
                : a.kind === "instance" &&
                  a.node !== undefined &&
                  this.classChain(a.node).includes(cls)
            )
              this.add(out, a);
          });
          return out;
        }
      }
      child = p;
      p = p.parent;
    }
    return value;
  }

  /** The class a condition proves `decl`'s value an instance of, if any. */
  guardClass(cond: ts.Expression, decl: Node): Node | "Promise" | null {
    const e = unparen(cond);
    if (ts.isBinaryExpression(e)) {
      if (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
        return this.guardClass(e.left, decl) ?? this.guardClass(e.right, decl);
      if (e.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword) return null;
      const l = unparen(e.left);
      if (!ts.isIdentifier(l) || this.resolve(l) !== decl) return null;
      return this.instanceofTarget(e.right);
    }
    if (
      ts.isCallExpression(e) &&
      ts.isIdentifier(unparen(e.expression)) &&
      e.arguments.nodes.length === 1
    ) {
      const arg = unparen(e.arguments.nodes[0]!);
      if (!ts.isIdentifier(arg) || this.resolve(arg) !== decl) return null;
      const fnDecl = this.resolve(unparen(e.expression));
      let fn: Node | undefined = fnDecl;
      if (fn !== undefined && ts.isVariableDeclaration(fn) && fn.initializer !== undefined)
        fn = unparen(fn.initializer);
      if (
        fn === undefined ||
        !(ts.isArrowFunction(fn) || ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn))
      )
        return null;
      const param = fn.parameters.nodes[0];
      if (param === undefined || !ts.isIdentifier(param.name)) return null;
      let body: Node | undefined = fn.body;
      if (body !== undefined && ts.isBlock(body)) {
        const stmts = body.statements.nodes;
        body =
          stmts.length === 1 && ts.isReturnStatement(stmts[0]!) ? stmts[0]!.expression : undefined;
      }
      if (body === undefined) return null;
      return this.predicateClass(body as ts.Expression, param);
    }
    return null;
  }

  /** `… && p instanceof C` in a predicate body over parameter `p`. */
  predicateClass(e: ts.Expression, param: Node): Node | "Promise" | null {
    const u = unparen(e);
    if (!ts.isBinaryExpression(u)) return null;
    if (u.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      return this.predicateClass(u.right, param) ?? this.predicateClass(u.left, param);
    if (u.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword) return null;
    const l = unparen(u.left);
    if (!ts.isIdentifier(l) || this.resolve(l) !== param) return null;
    return this.instanceofTarget(u.right);
  }

  instanceofTarget(right: ts.Expression): Node | "Promise" | null {
    const r = unparen(right);
    if (!ts.isIdentifier(r)) return null;
    const d = this.resolve(r);
    if (d === undefined || d.getSourceFile().isDeclarationFile)
      return r.text === "Promise" ? "Promise" : null;
    return ts.isClassLikeDeclaration(d) ? d : null;
  }

  private readonly namespaces = new Map<Node, number>();
  /** `import * as ns`: an object whose fields are the module's exports. */
  namespaceNode(mod: Node): number {
    const existing = this.namespaces.get(mod);
    if (existing !== undefined) return existing;
    const n = this.newNode();
    this.namespaces.set(mod, n);
    const atom = this.atoms.intern(`ns:${this.nodeKey(mod)}`, () => ({
      kind: "object",
      label: `namespace ${shortFile((mod as ts.SourceFile).fileName ?? "")}`,
      node: mod,
    }));
    this.add(n, atom);
    const sym = this.checker.getSymbolAtLocation(mod);
    if (sym !== undefined) {
      for (const ex of this.checker.getExportsOfModule(sym)) {
        let target = ex;
        if (target.flags & ts.SymbolFlags.Alias) {
          try {
            target = this.checker.getAliasedSymbol(target);
          } catch {
            continue;
          }
        }
        const d = target.valueDeclaration ?? target.declarations[0];
        if (d === undefined) continue;
        const value = this.declValue(d);
        if (value !== null) this.edge(value, this.field(atom, String(ex.escapedName)));
      }
    }
    return n;
  }

  declValue(d: Node): number | null {
    if (d.getSourceFile().isDeclarationFile || !this.files.includes(d.getSourceFile())) return null;
    if (ts.isFunctionDeclaration(d)) {
      const b = this.binding(d);
      const saved = this.currentFn;
      this.currentFn = null;
      this.add(b, this.fnAtom(d, null));
      this.currentFn = saved;
      return b;
    }
    if (ts.isClassDeclaration(d)) {
      const b = this.binding(d);
      this.add(b, this.classAtoms(d).cls);
      return b;
    }
    if (ts.isVariableDeclaration(d) || ts.isBindingElement(d) || ts.isParameter(d))
      return this.binding(d);
    if (ts.isSourceFile(d)) return this.namespaceNode(d);
    return null;
  }

  globalNode(name: string): number {
    if (MODELED_GLOBALS.has(name)) return this.constNode(this.builtin(name));
    if (name === "NaN" || name === "Infinity") return this.constNode(this.prim("number"));
    return this.constNode(this.top);
  }

  enclosingNonArrow(): FunctionInfo | null {
    const fn = this.currentFn;
    if (fn === null) return null;
    if (!fn.isArrow) return fn;
    // An arrow's `arguments` is its enclosing function's.
    let p: Node | undefined = fn.node.parent;
    while (p !== undefined) {
      if (ts.isFunctionLike(p) && !ts.isArrowFunction(p))
        return (
          this.functions.get(this.ctxKey(p)) ?? this.functions.get(`|${this.nodeKey(p)}`) ?? null
        );
      p = p.parent;
    }
    return null;
  }

  objectLiteral(e: ts.ObjectLiteralExpression): number {
    const keys: string[] = [];
    let keysKnown = true;
    let hasAccessor = false;
    let hasProto = false;
    let hasComputedKey = false;
    const spreads: number[] = [];
    const inPackage = isPackageJsFile(e.getSourceFile());
    const label = (): string =>
      `{${keys.slice(0, 6).join(",")}${keys.length > 6 ? ",…" : ""}${keysKnown ? "" : ",…"}}@${locLabel(e)}`;
    // keys first, so the label is complete
    for (const p of list(e.properties)) {
      if (ts.isSpreadAssignment(p)) {
        keysKnown = false;
        continue;
      }
      const name = (p as { name?: Node }).name;
      const key = name !== undefined ? propertyNameText(name) : null;
      if (key === null) {
        hasComputedKey = true;
        keysKnown = false;
        continue;
      }
      if (key === "__proto__" && ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name))
        hasProto = true;
      if (!keys.includes(key)) keys.push(key);
    }
    const atom = this.atoms.intern(`obj:${this.nodeKey(e)}`, () => ({
      kind: "object",
      label: label(),
      node: e,
    }));
    const n = this.newNode();
    this.add(n, atom);
    for (const p of list(e.properties)) {
      if (ts.isSpreadAssignment(p)) {
        const src = this.expr(p.expression);
        spreads.push(src);
        this.copyFields(src, atom, p);
        continue;
      }
      if (ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
        hasAccessor = true;
        const info = this.functionInfo(p, null);
        this.activate(info);
        this.add(info.thisNode, atom);
        const key = propertyNameText(p.name);
        if (key !== null && ts.isGetAccessorDeclaration(p))
          this.edge(info.ret, this.field(atom, key));
        continue;
      }
      const name = (p as { name?: Node }).name;
      const key = name !== undefined ? propertyNameText(name) : null;
      if (name !== undefined && ts.isComputedPropertyName(name)) this.expr(name.expression);
      let value: number;
      if (ts.isPropertyAssignment(p)) value = this.expr(p.initializer);
      else if (ts.isShorthandPropertyAssignment(p)) {
        const sym = this.checker.getShorthandAssignmentValueSymbol(p);
        const d = sym?.valueDeclaration ?? sym?.declarations[0];
        const id = p.name as ts.Identifier;
        value = d !== undefined ? (this.declValue(d) ?? this.identifier(id)) : this.identifier(id);
      } else if (ts.isMethodDeclaration(p)) {
        const fa = this.fnAtom(p, null);
        this.add(this.infoOfAtom(fa)!.thisNode, atom);
        value = this.constNode(fa);
      } else continue;
      if (key !== null) this.edge(value, this.field(atom, key));
      else this.edge(value, this.anyField(atom));
    }
    if (!this.siteAtoms.has(atom) && this.siteAtoms.add(atom))
      this.sites.push({
        atom,
        node: e,
        kind: "object",
        keys: keysKnown ? keys : null,
        hasAccessor,
        hasProto,
        hasComputedKey,
        spreads,
        inPackage,
      });
    return n;
  }

  /** Values written under unknown keys. */
  anyField(atom: Atom): number {
    return this.field(atom, "*");
  }

  /** Loads waiting for an atom's first write under an unknown key. */
  private readonly unknownKeyReaders = new Map<Atom, number[]>();

  /** dst ⊇ the values written to `atom` under unknown keys, now and later,
   * without creating the field for atoms that have none. */
  unknownKeysInto(atom: Atom, dst: number): void {
    const id = this.fields.get(atom)?.get("*");
    if (id !== undefined) {
      this.edge(id, dst);
      return;
    }
    let readers = this.unknownKeyReaders.get(atom);
    if (readers === undefined) {
      readers = [];
      this.unknownKeyReaders.set(atom, readers);
    }
    readers.push(dst);
  }

  copyFields(src: number, dstAtom: Atom, site: Node): void {
    this.on(src, (a) => {
      if (a.kind === "top") {
        this.edge(this.constNode(this.top), this.anyField(dstAtom));
        return;
      }
      if (a.kind === "prim" || a.kind === "builtin") return;
      if (a.kind === "array") {
        this.edge(this.element(a), this.anyField(dstAtom));
        return;
      }
      // Copy every own field the source has, now and later.
      const fm = this.fields.get(a);
      const copied = new Set<string>();
      const copy = (): void => {
        for (const [name, id] of this.fields.get(a) ?? new Map<string, number>()) {
          if (copied.has(name)) continue;
          copied.add(name);
          this.edge(id, this.field(dstAtom, name));
        }
      };
      copy();
      if (fm === undefined) this.fields.set(a, new Map());
      this.lateCopies.push(copy);
      if (a.kind === "instance" || a.kind === "dictionary" || a.kind === "collection")
        this.edge(this.constNode(this.top), this.anyField(dstAtom));
      void site;
    });
  }

  /** Field copies re-run after solving rounds (fields created later). */
  private readonly lateCopies: (() => void)[] = [];

  /** node ⊇ the own field and element values of every value in it, now and
   * later: the values JSON.stringify serializes. */
  childrenInto(node: number): void {
    this.on(node, (a) => {
      if (
        a.kind !== "object" &&
        a.kind !== "array" &&
        a.kind !== "instance" &&
        a.kind !== "dictionary"
      )
        return;
      const seen = new Set<string>();
      const copy = (): void => {
        for (const [name, id] of this.fields.get(a) ?? new Map<string, number>()) {
          if (seen.has(name) || name.startsWith("#")) continue;
          seen.add(name);
          this.edge(id, node);
        }
        const el = this.elements.get(a);
        if (el !== undefined && !seen.has("[]")) {
          seen.add("[]");
          this.edge(el, node);
        }
      };
      copy();
      this.lateCopies.push(copy);
    });
  }

  /** JSON.stringify's call of `value.toJSON(key)` on a value that has one
   * (a class member, or an own field once it exists); the result goes to `out`. */
  callToJSON(
    value: Atom,
    key: number,
    out: number,
    site: ts.CallExpression | ts.TaggedTemplateExpression,
  ): void {
    if (value.kind !== "object" && value.kind !== "instance" && value.kind !== "dictionary") return;
    let called = false;
    const call = (): void => {
      if (called) return;
      const has =
        this.fields.get(value)?.has("toJSON") === true ||
        (value.kind === "instance" && this.lookupMember(value.node!, "toJSON", false) !== null);
      if (!has) return;
      called = true;
      const fn = this.newNode();
      this.loadAtom(value, "toJSON", fn, site);
      this.invoke(fn, this.constNode(value), [key], false, out, site);
    };
    call();
    if (!called) this.lateCopies.push(call);
  }

  arrayLiteral(e: ts.ArrayLiteralExpression): number {
    const atom = this.atoms.intern(`arr:${this.nodeKey(e)}`, () => ({
      kind: "array",
      label: `[]@${locLabel(e)}`,
      node: e,
    }));
    const n = this.newNode();
    this.add(n, atom);
    const el = this.element(atom);
    let hasHole = false;
    for (const item of list(e.elements)) {
      if (ts.isOmittedExpression(item)) {
        hasHole = true;
        continue;
      }
      if (ts.isSpreadElement(item)) this.iterateInto(this.expr(item.expression), el, item);
      else this.edge(this.expr(item), el);
    }
    if (!this.siteAtoms.has(atom) && this.siteAtoms.add(atom))
      this.sites.push({
        atom,
        node: e,
        kind: "array",
        keys: null,
        hasAccessor: false,
        hasProto: hasHole,
        hasComputedKey: false,
        spreads: [],
        inPackage: isPackageJsFile(e.getSourceFile()),
      });
    return n;
  }

  binary(e: ts.BinaryExpression): number {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.EqualsToken) {
      const value = this.expr(e.right);
      this.assignTo(e.left, value);
      return value;
    }
    if (
      op === ts.SyntaxKind.BarBarEqualsToken ||
      op === ts.SyntaxKind.QuestionQuestionEqualsToken ||
      op === ts.SyntaxKind.AmpersandAmpersandEqualsToken
    ) {
      const n = this.newNode();
      this.edge(this.expr(e.left), n);
      const value = this.expr(e.right);
      this.edge(value, n);
      this.assignTo(e.left, value);
      return n;
    }
    if (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment) {
      this.expr(e.left);
      this.expr(e.right);
      const result = this.constNode(
        op === ts.SyntaxKind.PlusEqualsToken ? this.top : this.prim("number"),
      );
      if (op === ts.SyntaxKind.PlusEqualsToken) {
        this.nodes[result]!.atoms.clear();
        this.add(result, this.prim("string"));
        this.add(result, this.prim("number"));
      }
      this.assignTo(e.left, result);
      return result;
    }
    if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      const n = this.newNode();
      this.edge(this.expr(e.left), n);
      this.edge(this.expr(e.right), n);
      return n;
    }
    if (op === ts.SyntaxKind.CommaToken) {
      this.expr(e.left);
      return this.expr(e.right);
    }
    const l = this.expr(e.left);
    const r = this.expr(e.right);
    switch (op) {
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
      case ts.SyntaxKind.LessThanToken:
      case ts.SyntaxKind.LessThanEqualsToken:
      case ts.SyntaxKind.GreaterThanToken:
      case ts.SyntaxKind.GreaterThanEqualsToken:
      case ts.SyntaxKind.InstanceOfKeyword:
      case ts.SyntaxKind.InKeyword:
        if (op === ts.SyntaxKind.InKeyword)
          this.ops.push({ kind: "computedRead", recv: r, name: null, node: e });
        return this.constNode(this.prim("boolean"));
      case ts.SyntaxKind.PlusToken: {
        const n = this.newNode();
        const strOrNum = (a: Atom): void => {
          this.add(
            n,
            a.kind === "prim" && a.label === "number" ? this.prim("number") : this.prim("string"),
          );
          if (
            a.kind === "prim" &&
            (a.label === "boolean" || a.label === "null" || a.label === "undefined")
          )
            this.add(n, this.prim("number"));
          if (a.kind === "top") this.add(n, this.prim("number"));
        };
        this.on(l, strOrNum);
        this.on(r, strOrNum);
        return n;
      }
      default:
        return this.constNode(this.prim("number"));
    }
  }

  assignTo(target: ts.Expression, value: number): void {
    const t = unparen(target);
    if (ts.isIdentifier(t)) {
      const decl = this.resolve(t);
      if (decl === undefined || decl.getSourceFile().isDeclarationFile) {
        this.sink(value, `global write at ${locLabel(t)}`);
        return;
      }
      this.edge(value, this.binding(decl));
      return;
    }
    if (ts.isPropertyAccessExpression(t)) {
      const recv = this.expr(t.expression);
      this.storeConstraint(recv, t.name.text, value, t);
      this.ops.push({
        kind: t.name.text === "length" ? "lengthWrite" : "write",
        recv,
        name: t.name.text,
        node: t,
      });
      return;
    }
    if (ts.isElementAccessExpression(t)) {
      const recv = this.expr(t.expression);
      const key = unparen(t.argumentExpression);
      if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
        this.storeConstraint(recv, key.text, value, t);
        this.ops.push({ kind: "write", recv, name: key.text, node: t });
      } else {
        this.expr(t.argumentExpression);
        this.computedStore(recv, value, t);
        this.ops.push({ kind: "computedWrite", recv, name: null, node: t });
      }
      return;
    }
    if (ts.isObjectLiteralExpression(t)) {
      for (const p of list(t.properties)) {
        if (ts.isPropertyAssignment(p)) {
          const key = propertyNameText(p.name);
          const n = this.newNode();
          if (key !== null) this.loadConstraint(value, key, n, p);
          else this.add(n, this.top);
          this.assignTo(p.initializer, n);
        } else if (ts.isShorthandPropertyAssignment(p)) {
          const n = this.newNode();
          const id = p.name as ts.Identifier;
          this.loadConstraint(value, id.text, n, p);
          this.assignTo(id, n);
        }
      }
      return;
    }
    if (ts.isArrayLiteralExpression(t)) {
      for (const el of list(t.elements)) {
        if (ts.isOmittedExpression(el)) continue;
        const n = this.newNode();
        this.iterateInto(value, n, el);
        this.assignTo(ts.isSpreadElement(el) ? el.expression : el, n);
      }
    }
  }

  // ---- loads and stores ------------------------------------------------------------

  loadConstraint(recv: number, name: string, dst: number, site: Node): void {
    this.on(recv, (a) => this.loadAtom(a, name, dst, site));
  }

  loadAtom(a: Atom, name: string, dst: number, site: Node): void {
    switch (a.kind) {
      case "top":
        this.add(dst, this.top);
        return;
      case "prim":
        if (name === "length" && a.label === "string") this.add(dst, this.prim("number"));
        else if (a.label === "string" || a.label === "number" || a.label === "boolean")
          this.add(dst, this.builtin(`${a.label}.${name}`, a));
        return;
      case "instance": {
        const decl = a.node!;
        if (name === "constructor") {
          this.add(dst, this.classAtoms(decl).cls);
          return;
        }
        const member = this.lookupMember(decl, name, false);
        if (member?.kind === "method")
          this.add(
            dst,
            this.fnAtom(member.method!, this.ownerOf(member.method!), this.receiverCtx(a)),
          );
        if (member !== null && member.get !== undefined) {
          const g = this.functionInfo(member.get, this.ownerOf(member.get), this.receiverCtx(a));
          this.activate(g);
          this.add(g.thisNode, a);
          this.edge(g.ret, dst);
          this.edgeFor(site, g);
          return;
        }
        if (this.classChain(decl).some((c) => this.baseClass(c) === undefined))
          this.add(dst, this.top);
        this.edge(this.field(a, name), dst);
        this.unknownKeysInto(a, dst);
        return;
      }
      case "class": {
        const decl = a.node!;
        if (name === "prototype") {
          this.add(dst, this.top);
          return;
        }
        if (name === "name") {
          this.add(dst, this.prim("string"));
          return;
        }
        const member = this.lookupMember(decl, name, true);
        if (member?.kind === "method")
          this.add(
            dst,
            this.fnAtom(member.method!, this.ownerOf(member.method!), this.receiverCtx(a)),
          );
        if (member?.get !== undefined) {
          const g = this.functionInfo(member.get, this.ownerOf(member.get), this.receiverCtx(a));
          this.activate(g);
          this.add(g.thisNode, a);
          this.edge(g.ret, dst);
          return;
        }
        // static fields of the class and its bases
        for (const c of this.classChain(decl)) {
          const cls = this.classAtoms(c).cls;
          this.edge(this.field(cls, name), dst);
          this.unknownKeysInto(cls, dst);
        }
        return;
      }
      case "function":
        if (name === "call" || name === "apply" || name === "bind")
          this.add(dst, this.builtin(`function.${name}`, a));
        else if (name === "prototype") this.add(dst, this.top);
        else if (name === "name") this.add(dst, this.prim("string"));
        else if (name === "length") this.add(dst, this.prim("number"));
        else {
          this.edge(this.field(a, name), dst);
          this.unknownKeysInto(a, dst);
        }
        return;
      case "array":
        if (name === "length") this.add(dst, this.prim("number"));
        else if (/^\d+$/.test(name)) this.edge(this.element(a), dst);
        else if (ARRAY_METHODS.has(name)) this.add(dst, this.builtin(`array.${name}`, a));
        else this.edge(this.field(a, name), dst);
        return;
      case "object":
        this.edge(this.field(a, name), dst);
        this.edge(this.anyField(a), dst);
        if (name === "constructor" || name === "hasOwnProperty" || name === "toString")
          this.add(dst, this.builtin(`object.${name}`, a));
        return;
      case "dictionary":
        this.edge(this.anyField(a), dst);
        this.edge(this.field(a, name), dst);
        return;
      case "promise":
        if (name === "then" || name === "catch" || name === "finally")
          this.add(dst, this.builtin(`promise.${name}`, a));
        return;
      case "collection":
        if (name === "size") this.add(dst, this.prim("number"));
        else this.add(dst, this.builtin(`collection.${name}`, a));
        return;
      case "builtin":
        this.loadBuiltin(a, name, dst);
        return;
    }
    void site;
  }

  ownerOf(member: Node): Node | null {
    const p = member.parent;
    return p !== undefined && ts.isClassLikeDeclaration(p) ? p : null;
  }

  loadBuiltin(a: Atom, name: string, dst: number): void {
    const path = a.path ?? "";
    if (
      path === "Number" &&
      (name === "MAX_SAFE_INTEGER" ||
        name === "MIN_SAFE_INTEGER" ||
        name === "EPSILON" ||
        name === "MAX_VALUE" ||
        name === "MIN_VALUE" ||
        name === "POSITIVE_INFINITY" ||
        name === "NEGATIVE_INFINITY" ||
        name === "NaN")
    )
      this.add(dst, this.prim("number"));
    else if (path === "Math" && /^[A-Z0-9_]+$/.test(name)) this.add(dst, this.prim("number"));
    else if (path === "Symbol") this.add(dst, this.prim("symbol"));
    else if (path === "Error.instance" || path === "error") {
      if (name === "message" || name === "stack" || name === "name")
        this.add(dst, this.prim("string"));
      else this.add(dst, this.top);
    } else if (
      a.receiver === undefined &&
      MODELED_GLOBALS.has(path.split(".")[0]!) &&
      path.split(".").length < 4
    )
      this.add(dst, this.builtin(`${path}.${name}`));
    else if (path === "RegExp.instance") this.add(dst, this.builtin(`regexp.${name}`, a));
    else this.add(dst, this.top);
  }

  storeConstraint(recv: number, name: string, value: number, site: Node): void {
    this.on(recv, (a) => {
      switch (a.kind) {
        case "top":
          this.noteTopWrite(name, site);
          this.sink(value, `stored into ⊤.${name} at ${locLabel(site)}`);
          return;
        case "instance": {
          const member = this.lookupMember(a.node!, name, false);
          if (member?.set !== undefined) {
            const s = this.functionInfo(member.set, this.ownerOf(member.set), this.receiverCtx(a));
            this.activate(s);
            this.add(s.thisNode, a);
            if (s.params[0] !== undefined) this.edge(value, s.params[0]);
            return;
          }
          this.edge(value, this.field(a, name));
          return;
        }
        case "class":
        case "function":
        case "object":
        case "dictionary":
          this.edge(value, this.field(a, name));
          return;
        case "array":
          if (/^\d+$/.test(name)) this.edge(value, this.element(a));
          else if (name !== "length") this.edge(value, this.field(a, name));
          return;
        case "prim":
          return;
        default:
          this.sink(value, `stored into ${a.label} at ${locLabel(site)}`);
      }
    });
  }

  computedLoad(recv: number, dst: number, site: Node): void {
    this.on(recv, (a) => {
      switch (a.kind) {
        case "top":
          this.add(dst, this.top);
          return;
        case "array":
        case "collection":
          this.edge(this.element(a), dst);
          return;
        case "prim":
          if (a.label === "string") this.add(dst, this.prim("string"));
          return;
        case "object":
        case "dictionary":
        case "instance":
        case "class":
        case "function": {
          // every field, now and later
          const seen = new Set<string>();
          const copy = (): void => {
            for (const [name, id] of this.fields.get(a) ?? new Map<string, number>()) {
              if (seen.has(name)) continue;
              seen.add(name);
              this.edge(id, dst);
            }
          };
          copy();
          this.lateCopies.push(copy);
          if (a.kind === "instance" || a.kind === "class") this.add(dst, this.top);
          return;
        }
        default:
          this.add(dst, this.top);
      }
      void site;
    });
  }

  computedStore(recv: number, value: number, site: Node): void {
    this.on(recv, (a) => {
      switch (a.kind) {
        case "top":
          this.noteTopWrite(null, site);
          this.sink(value, `stored into ⊤[k] at ${locLabel(site)}`);
          return;
        case "array":
          this.edge(value, this.element(a));
          return;
        case "prim":
          return;
        default:
          this.edge(value, this.anyField(a));
      }
    });
  }

  // ---- calls ---------------------------------------------------------------------------

  /** tag`…${x}…`: a call of the tag with the template's strings array (an
   * array of strings with a `raw` array of strings) and each substitution. */
  taggedTemplate(e: ts.TaggedTemplateExpression): number {
    this.noteSite(e);
    const tag = unparen(e.tag);
    const recv =
      ts.isPropertyAccessExpression(tag) && tag.expression.kind !== ts.SyntaxKind.SuperKeyword
        ? this.expr(tag.expression)
        : null;
    const callee = recv === null ? this.expr(tag) : null;
    const strings = this.syntheticArray(e, "template");
    const raw = this.syntheticArray(e.template, "raw");
    this.add(this.element(strings), this.prim("string"));
    this.add(this.element(raw), this.prim("string"));
    this.add(this.field(strings, "raw"), raw);
    const args = [this.constNode(strings)];
    if (ts.isTemplateExpression(e.template))
      for (const span of list(e.template.templateSpans)) args.push(this.expr(span.expression));
    const dst = this.newNode();
    if (recv !== null && ts.isPropertyAccessExpression(tag)) {
      const name = tag.name.text;
      this.ops.push({ kind: "read", recv, name, node: tag });
      this.on(recv, (a) => {
        const fn = this.newNode();
        this.loadAtom(a, name, fn, tag);
        this.invoke(fn, this.constNode(a), args, false, dst, e);
      });
    } else this.invoke(callee!, null, args, false, dst, e);
    return dst;
  }

  args(e: ts.CallExpression | ts.NewExpression): { args: number[]; spread: boolean } {
    const out: number[] = [];
    let spread = false;
    for (const a of list(e.arguments)) {
      if (ts.isSpreadElement(a)) {
        const inner = unparen(a.expression);
        if (ts.isIdentifier(inner) && inner.text === "arguments") {
          // `f(...arguments)`: forward the enclosing function's parameters.
          const fn = this.enclosingNonArrow();
          if (fn !== null && out.length === 0) {
            if (fn.argPos === null) fn.argPos = [0, 1, 2, 3, 4, 5].map(() => this.newNode());
            out.push(...fn.argPos);
            continue;
          }
        }
        spread = true;
        out.push(this.expr(a.expression));
        continue;
      }
      out.push(this.expr(a));
    }
    return { args: out, spread };
  }

  call(e: ts.CallExpression): number {
    this.noteSite(e);
    const callee = unparen(e.expression);
    const dst = this.newNode();
    if (callee.kind === ts.SyntaxKind.SuperKeyword) {
      const { args, spread } = this.args(e);
      const fn = this.enclosingNonArrow();
      const owner = fn?.ownerClass ?? null;
      const base = owner !== null ? this.baseClass(owner) : undefined;
      if (fn !== null && base) {
        this.on(fn.thisNode, (inst) => {
          if (inst.kind === "instance") this.callConstructorChain(base, inst, args, spread, e);
        });
      } else if (base === undefined)
        for (const a of args) this.sink(a, `super(...) at ${locLabel(e)}`);
      return dst;
    }
    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      const recvExpr = unparen(callee.expression);
      const { args, spread } = this.args(e);
      if (recvExpr.kind === ts.SyntaxKind.SuperKeyword && ts.isPropertyAccessExpression(callee)) {
        // super.m(...): the base class member with the current receiver.
        const fn = this.enclosingNonArrow();
        const owner = fn?.ownerClass ?? null;
        const base = owner !== null ? this.baseClass(owner) : undefined;
        if (fn !== null && base) {
          const member = this.lookupMember(base, callee.name.text, isStatic(fn.node));
          if (member?.method !== undefined) {
            this.callFunction(
              this.functionInfo(member.method, this.ownerOf(member.method), fn.ctx),
              fn.thisNode,
              args,
              spread,
              dst,
              e,
            );
          }
        }
        return dst;
      }
      const recv = this.expr(recvExpr);
      let name: string | null = null;
      if (ts.isPropertyAccessExpression(callee)) name = callee.name.text;
      else {
        const k = unparen(callee.argumentExpression);
        if (ts.isStringLiteral(k) || ts.isNoSubstitutionTemplateLiteral(k)) name = k.text;
        else this.expr(callee.argumentExpression);
      }
      if (name !== null) this.ops.push({ kind: "read", recv, name, node: callee });
      // Per receiver atom: the member it resolves to runs with that atom as `this`.
      const member = name;
      this.on(recv, (a) => {
        const fnNode = this.newNode();
        const self = this.constNode(a);
        if (member !== null) this.loadAtom(a, member, fnNode, callee);
        else this.computedLoad(self, fnNode, callee);
        this.invoke(fnNode, self, args, spread, dst, e);
      });
      return dst;
    }
    const calleeNode = this.expr(callee);
    const { args, spread } = this.args(e);
    this.invoke(calleeNode, null, args, spread, dst, e);
    return dst;
  }

  invoke(
    callee: number,
    recv: number | null,
    args: number[],
    spread: boolean,
    dst: number,
    site: ts.CallExpression | ts.TaggedTemplateExpression,
  ): void {
    const undefNode = recv === null ? this.constNode(this.prim("undefined")) : recv;
    this.on(callee, (a) => {
      switch (a.kind) {
        case "function":
          this.callFunction(this.infoOfAtom(a)!, undefNode, args, spread, dst, site);
          return;
        case "builtin":
          this.callBuiltin(a, args, spread, dst, site, recv);
          return;
        case "class":
          return; // calling a class throws
        case "prim":
          return;
        default:
          for (const x of args) this.sink(x, `argument of ⊤ call at ${locLabel(site)}`);
          if (recv !== null && a.kind === "top")
            this.sink(recv, `receiver of ⊤ call at ${locLabel(site)}`);
          this.add(dst, this.top);
      }
    });
  }

  newExpr(e: ts.NewExpression): number {
    this.noteSite(e);
    const dst = this.newNode();
    const callee = this.expr(e.expression);
    const { args, spread } = this.args(e);
    this.on(callee, (a) => {
      switch (a.kind) {
        case "class":
          this.construct(a.node!, args, spread, dst, e);
          return;
        case "function": {
          // An ES5 constructor function: one instance atom per function.
          const inst = this.atoms.intern(`fninst:${this.nodeKey(a.node!)}`, () => ({
            kind: "object",
            label: `new ${a.label}`,
            node: a.node,
          }));
          this.add(dst, inst);
          const info = this.infoOfAtom(a);
          if (info !== undefined) {
            this.activate(info);
            this.add(info.thisNode, inst);
            this.bindArgs(info, args, spread);
            this.edge(info.ret, dst);
          }
          return;
        }
        case "builtin":
          this.constructBuiltin(a.path ?? "", args, dst, e);
          return;
        default:
          for (const x of args) this.sink(x, `argument of ⊤ constructor at ${locLabel(e)}`);
          this.add(dst, this.top);
      }
    });
    return dst;
  }

  constructBuiltin(path: string, args: number[], dst: number, site: Node): void {
    switch (path) {
      case "Map":
      case "Set":
      case "WeakMap":
      case "WeakSet": {
        const c = this.atoms.intern(`coll:${this.nodeKey(site)}`, () => ({
          kind: "collection",
          label: `${path}@${locLabel(site)}`,
          node: site,
        }));
        this.add(dst, c);
        if (args[0] !== undefined) this.iterateInto(args[0], this.element(c), site);
        return;
      }
      case "Error":
      case "TypeError":
      case "RangeError":
      case "SyntaxError":
        this.add(dst, this.builtin("Error.instance"));
        return;
      case "Promise": {
        const p = this.promiseAtom(site, locLabel(site));
        this.add(this.field(p, "value"), this.top);
        this.add(dst, p);
        if (args[0] !== undefined) {
          const resolver = this.constNode(this.builtin("promise.resolver"));
          this.on(args[0], (f) => {
            if (f.kind === "function")
              this.callFunction(
                this.infoOfAtom(f)!,
                null,
                [resolver, resolver],
                false,
                this.newNode(),
                site,
              );
          });
        }
        return;
      }
      case "Date":
        this.add(dst, this.builtin("Date.instance"));
        return;
      case "RegExp":
        this.add(dst, this.builtin("RegExp.instance"));
        return;
      case "Array": {
        this.add(dst, this.syntheticArray(site, "Array"));
        return;
      }
      case "Proxy":
        // The handler's traps run on every operation with the target.
        if (args[0] !== undefined)
          this.ops.push({ kind: "proxy", recv: args[0], name: null, node: site });
        for (const x of args) this.sink(x, `argument of new Proxy at ${locLabel(site)}`);
        this.add(dst, this.top);
        return;
      default:
        for (const x of args) this.sink(x, `argument of new ${path} at ${locLabel(site)}`);
        this.add(dst, this.top);
    }
  }

  /** Builtin call summaries; anything unmodeled makes its arguments escape. */
  callBuiltin(
    a: Atom,
    args: number[],
    spread: boolean,
    dst: number,
    site: ts.CallExpression | ts.TaggedTemplateExpression,
    recvNode: number | null,
  ): void {
    const path = a.path ?? "";
    const recv = a.receiver;
    const arg = (i: number): number => args[i] ?? this.constNode(this.prim("undefined"));
    const prim = (p: string): void => this.add(dst, this.prim(p));
    const callback = (i: number, cbArgs: number[], ret: number | null): void => {
      if (args[i] === undefined) return;
      this.on(args[i]!, (f) => {
        if (f.kind === "function") {
          const saved = this.forceLoop;
          this.forceLoop = LOOP_CALLBACK_METHODS.has(path.slice(path.indexOf(".") + 1));
          this.callFunction(this.infoOfAtom(f)!, null, cbArgs, false, ret ?? this.newNode(), site);
          this.forceLoop = saved;
        } else if (f.kind === "top" || f.kind === "builtin") {
          for (const x of cbArgs) this.sink(x, `argument of ⊤ callback at ${locLabel(site)}`);
          if (ret !== null) this.add(ret, this.top);
        }
      });
    };
    const escapeAll = (): void => {
      for (const x of args) this.sink(x, `argument of ${path} at ${locLabel(site)}`);
      this.add(dst, this.top);
    };
    // Methods of builtin receivers.
    if (recv !== undefined) {
      const method = path.slice(path.indexOf(".") + 1);
      if (path.startsWith("array.")) {
        const el = this.element(recv);
        const num = this.constNode(this.prim("number"));
        const recvN = this.constNode(recv);
        switch (method) {
          case "push":
          case "unshift":
            for (const x of args) {
              if (spread) this.iterateInto(x, el, site);
              else this.edge(x, el);
            }
            prim("number");
            return;
          case "pop":
          case "shift":
          case "at":
            this.edge(el, dst);
            this.add(dst, this.prim("undefined"));
            return;
          case "find":
          case "findLast":
            callback(0, [el, num, recvN], null);
            this.edge(el, dst);
            this.add(dst, this.prim("undefined"));
            return;
          case "forEach":
            callback(0, [el, num, recvN], null);
            prim("undefined");
            return;
          case "some":
          case "every":
          case "includes":
            callback(0, [el, num, recvN], null);
            prim("boolean");
            return;
          case "findIndex":
          case "findLastIndex":
          case "indexOf":
          case "lastIndexOf":
            callback(0, [el, num, recvN], null);
            prim("number");
            return;
          case "join":
          case "toString":
            prim("string");
            return;
          case "map":
          case "flatMap": {
            const out = this.syntheticArray(site, method);
            const outEl = this.element(out);
            if (method === "map") callback(0, [el, num, recvN], outEl);
            else {
              const r = this.newNode();
              callback(0, [el, num, recvN], r);
              this.iterateInto(r, outEl, site);
            }
            this.add(dst, out);
            return;
          }
          case "filter":
          case "slice":
          case "concat":
          case "reverse":
          case "sort":
          case "splice":
          case "toSorted":
          case "toReversed":
          case "flat": {
            if (method === "filter") callback(0, [el, num, recvN], null);
            if (method === "sort" || method === "toSorted") callback(0, [el, el], null);
            if (method === "reverse" || method === "sort") {
              this.add(dst, recv);
              return;
            }
            const out = this.syntheticArray(site, method);
            this.edge(el, this.element(out));
            if (method === "concat")
              for (const x of args) this.iterateInto(x, this.element(out), site);
            if (method === "splice") for (const x of args.slice(2)) this.edge(x, el);
            this.add(dst, out);
            return;
          }
          case "reduce":
          case "reduceRight": {
            const acc = this.newNode();
            if (args[1] !== undefined) this.edge(args[1], acc);
            else this.edge(el, acc);
            callback(0, [acc, el, num, recvN], acc);
            this.edge(acc, dst);
            return;
          }
          case "keys":
          case "values":
          case "entries": {
            const out = this.syntheticArray(site, method);
            if (method === "values") this.edge(el, this.element(out));
            else if (method === "keys") this.add(this.element(out), this.prim("number"));
            else {
              const pair = this.syntheticArray(site, "entry");
              this.add(this.element(pair), this.prim("number"));
              this.edge(el, this.element(pair));
              this.add(this.element(out), pair);
            }
            this.add(dst, out);
            return;
          }
          case "fill":
            for (const x of args) this.edge(x, el);
            this.add(dst, recv);
            return;
        }
        escapeAll();
        this.escape(recv, `array.${method} at ${locLabel(site)}`);
        return;
      }
      if (path.startsWith("string.") || path.startsWith("number.") || path.startsWith("boolean.")) {
        const r = STRING_METHOD_RESULTS.get(method);
        if (r === "array") {
          const out = this.syntheticArray(site, method);
          this.add(this.element(out), this.prim("string"));
          this.add(this.element(out), this.prim("undefined"));
          this.add(dst, out);
          this.add(dst, this.prim("null"));
        } else if (r !== undefined) prim(r);
        else if (method === "replace" || method === "replaceAll") prim("string");
        else escapeAll();
        if (method === "replace" || method === "replaceAll")
          callback(1, [this.constNode(this.prim("string"))], null);
        return;
      }
      if (path.startsWith("regexp.")) {
        if (method === "test") prim("boolean");
        else if (method === "exec") {
          const out = this.syntheticArray(site, "exec");
          this.add(this.element(out), this.prim("string"));
          this.add(dst, out);
          prim("null");
        } else escapeAll();
        return;
      }
      if (path.startsWith("promise.")) {
        const out = this.promiseAtom(site, locLabel(site));
        const value = this.field(recv, "value");
        const ret = this.newNode();
        if (method === "then") {
          callback(0, [value], ret);
          callback(1, [this.constNode(this.top)], ret);
        } else if (method === "catch") {
          callback(0, [this.constNode(this.top)], ret);
          this.edge(value, ret);
        } else {
          callback(0, [], null);
          this.edge(value, ret);
        }
        this.awaitInto(ret, this.field(out, "value"));
        this.add(dst, out);
        return;
      }
      if (path.startsWith("collection.")) {
        const el = this.element(recv);
        switch (method) {
          case "add":
          case "set":
            for (const x of args) this.edge(x, el);
            this.add(dst, recv);
            return;
          case "get":
            this.edge(el, dst);
            prim("undefined");
            return;
          case "has":
          case "delete":
            prim("boolean");
            return;
          case "clear":
            prim("undefined");
            return;
          case "forEach":
            callback(0, [el, el], null);
            prim("undefined");
            return;
          case "keys":
          case "values":
          case "entries": {
            const out = this.syntheticArray(site, method);
            this.edge(el, this.element(out));
            if (method === "entries") {
              const pair = this.syntheticArray(site, "entry");
              this.edge(el, this.element(pair));
              this.nodes[this.element(out)]!.atoms.clear();
              this.add(this.element(out), pair);
            }
            this.add(dst, out);
            return;
          }
        }
        escapeAll();
        return;
      }
      if (path.startsWith("function.")) {
        if (recv.kind !== "function" || recv.node === undefined) {
          escapeAll();
          return;
        }
        if (method === "bind") {
          const info = this.infoOfAtom(recv);
          if (info !== undefined && args[0] !== undefined && !info.isArrow)
            this.edge(args[0], info.thisNode);
          if (info !== undefined && args.length > 1) {
            this.activate(info);
            for (const p of info.params) this.add(p, this.top);
            for (const x of args.slice(1)) this.sink(x, `bound argument at ${locLabel(site)}`);
          }
          this.add(dst, recv);
          return;
        }
        if (method === "call") {
          this.callFunction(
            this.infoOfAtom(recv)!,
            args[0] ?? this.constNode(this.prim("undefined")),
            args.slice(1),
            spread,
            dst,
            site,
          );
          return;
        }
        // apply: arguments from an array
        const info = this.infoOfAtom(recv);
        if (info !== undefined) {
          this.activate(info);
          if (args[0] !== undefined && !info.isArrow) this.edge(args[0], info.thisNode);
          for (const p of info.params)
            if (args[1] !== undefined) this.iterateInto(args[1], p, site);
          this.edge(info.ret, dst);
        }
        return;
      }
      if (path.startsWith("object.")) {
        if (method === "hasOwnProperty") prim("boolean");
        else if (method === "toString") prim("string");
        else escapeAll();
        return;
      }
      escapeAll();
      return;
    }
    // `Object.prototype.m.call(o, …)`-style calls of builtin prototype methods.
    if (/^(Object|Array|String|Function)\.prototype\.\w+\.(call|apply)$/.test(path)) {
      const m = path.split(".")[2]!;
      if (m === "hasOwnProperty" || m === "propertyIsEnumerable" || m === "isPrototypeOf")
        prim("boolean");
      else if (m === "toString") prim("string");
      else escapeAll();
      return;
    }
    switch (path) {
      case "Object.keys":
      case "Object.getOwnPropertyNames": {
        const out = this.syntheticArray(site, "keys");
        this.add(this.element(out), this.prim("string"));
        this.add(dst, out);
        return;
      }
      case "Object.values":
      case "Object.entries": {
        const out = this.syntheticArray(site, path === "Object.values" ? "values" : "entries");
        const vals = this.newNode();
        if (args[0] !== undefined) this.computedLoad(args[0], vals, site);
        if (path === "Object.values") this.edge(vals, this.element(out));
        else {
          const pair = this.syntheticArray(site, "entry");
          this.add(this.element(pair), this.prim("string"));
          this.edge(vals, this.element(pair));
          this.add(this.element(out), pair);
        }
        this.add(dst, out);
        return;
      }
      case "Object.freeze":
      case "Object.seal":
      case "Object.preventExtensions":
        this.ops.push({
          kind: path === "Object.freeze" ? "freeze" : "seal",
          recv: arg(0),
          name: null,
          node: site,
        });
        this.edge(arg(0), dst);
        return;
      case "Object.isFrozen":
      case "Object.isSealed":
      case "Object.isExtensible":
      case "Array.isArray":
      case "Number.isInteger":
      case "Number.isNaN":
      case "Number.isFinite":
      case "Number.isSafeInteger":
      case "isNaN":
      case "isFinite":
        prim("boolean");
        return;
      case "Object.assign": {
        this.ops.push({ kind: "assign", recv: arg(0), name: null, node: site });
        this.on(arg(0), (t) => {
          for (const s of args.slice(1)) this.copyFields(s, t, site);
          if (t.kind === "top")
            for (const s of args.slice(1))
              this.sink(s, `Object.assign into ⊤ at ${locLabel(site)}`);
        });
        this.edge(arg(0), dst);
        return;
      }
      case "Object.defineProperty":
      case "Object.defineProperties":
      case "Reflect.defineProperty":
        this.ops.push({ kind: "defineProperty", recv: arg(0), name: null, node: site });
        this.sink(arg(2), `property descriptor at ${locLabel(site)}`);
        this.sink(arg(1), `property descriptor at ${locLabel(site)}`);
        this.edge(arg(0), dst);
        return;
      case "Object.setPrototypeOf":
      case "Reflect.setPrototypeOf":
        this.ops.push({ kind: "setPrototypeOf", recv: arg(0), name: null, node: site });
        this.sink(arg(1), `prototype at ${locLabel(site)}`);
        this.edge(arg(0), dst);
        return;
      case "Object.create": {
        const d = this.atoms.intern(`dict:${this.nodeKey(site)}`, () => ({
          kind: "dictionary",
          label: `Object.create@${locLabel(site)}`,
          node: site,
        }));
        this.add(dst, d);
        return;
      }
      case "Object.fromEntries": {
        const d = this.atoms.intern(`dict:${this.nodeKey(site)}`, () => ({
          kind: "dictionary",
          label: `fromEntries@${locLabel(site)}`,
          node: site,
        }));
        const pairs = this.newNode();
        if (args[0] !== undefined) this.iterateInto(args[0], pairs, site);
        const vals = this.newNode();
        this.iterateInto(pairs, vals, site);
        this.edge(vals, this.anyField(d));
        this.add(dst, d);
        return;
      }
      case "Object.getPrototypeOf":
      case "Reflect.getPrototypeOf":
        this.add(dst, this.top);
        return;
      case "Object.is":
        prim("boolean");
        return;
      case "Array.from":
      case "Array.of": {
        const out = this.syntheticArray(site, path);
        if (path === "Array.of") for (const x of args) this.edge(x, this.element(out));
        else if (args[1] !== undefined) {
          const els = this.newNode();
          if (args[0] !== undefined) this.iterateInto(args[0], els, site);
          callback(1, [els, this.constNode(this.prim("number"))], this.element(out));
        } else if (args[0] !== undefined) this.iterateInto(args[0], this.element(out), site);
        this.add(dst, out);
        return;
      }
      case "JSON.parse":
        // A reviver runs on every parsed value with its key, the holder as `this`.
        if (args[1] !== undefined)
          this.on(args[1], (f) => {
            if (f.kind === "function")
              this.callFunction(
                this.infoOfAtom(f)!,
                this.constNode(this.top),
                [this.constNode(this.prim("string")), this.constNode(this.top)],
                false,
                this.newNode(),
                site,
              );
          });
        this.add(dst, this.top);
        return;
      case "JSON.stringify": {
        // Every value it serializes: toJSON methods run on them, and a
        // replacer function with each key and value, the holder as `this`.
        // Their results are serialized in turn.
        const serialized = this.newNode();
        this.childrenInto(serialized);
        this.edge(arg(0), serialized);
        const key = this.constNode(this.prim("string"));
        this.on(serialized, (v) => this.callToJSON(v, key, serialized, site));
        if (args[1] !== undefined)
          this.on(args[1], (f) => {
            if (f.kind === "function")
              this.callFunction(
                this.infoOfAtom(f)!,
                serialized,
                [key, serialized],
                false,
                serialized,
                site,
              );
            else if (f.kind === "top")
              this.sink(serialized, `JSON.stringify replacer at ${locLabel(site)}`);
          });
        prim("string");
        prim("undefined");
        return;
      }
      case "Reflect.deleteProperty": {
        const key = ts.isCallExpression(site) ? unparen(list(site.arguments)[1]!) : undefined;
        const name =
          key !== undefined && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))
            ? key.text
            : null;
        this.ops.push({ kind: "delete", recv: arg(0), name, node: site });
        prim("boolean");
        return;
      }
      case "Proxy.revocable":
        this.ops.push({ kind: "proxy", recv: arg(0), name: null, node: site });
        escapeAll();
        return;
      case "String":
      case "encodeURIComponent":
      case "decodeURIComponent":
      case "encodeURI":
      case "decodeURI":
        prim("string");
        return;
      case "Number":
      case "parseInt":
      case "parseFloat":
      case "Number.parseInt":
      case "Number.parseFloat":
        prim("number");
        return;
      case "Boolean":
        prim("boolean");
        return;
      case "Symbol":
      case "Symbol.for":
        prim("symbol");
        return;
      case "BigInt":
        prim("bigint");
        return;
      case "Promise.resolve": {
        const p = this.promiseAtom(site, locLabel(site));
        if (args[0] !== undefined) this.awaitInto(args[0], this.field(p, "value"));
        else this.add(this.field(p, "value"), this.prim("undefined"));
        this.add(dst, p);
        return;
      }
      case "Promise.reject": {
        const p = this.promiseAtom(site, locLabel(site));
        this.add(dst, p);
        if (args[0] !== undefined) this.sink(args[0], `rejection at ${locLabel(site)}`);
        return;
      }
      case "Promise.all":
      case "Promise.allSettled":
      case "Promise.race":
      case "Promise.any": {
        const p = this.promiseAtom(site, locLabel(site));
        const items = this.newNode();
        if (args[0] !== undefined) this.iterateInto(args[0], items, site);
        if (path === "Promise.all") {
          const out = this.syntheticArray(site, "all");
          this.awaitInto(items, this.element(out));
          this.add(this.field(p, "value"), out);
        } else if (path === "Promise.race" || path === "Promise.any")
          this.awaitInto(items, this.field(p, "value"));
        else this.add(this.field(p, "value"), this.top);
        this.add(dst, p);
        return;
      }
      case "promise.resolver":
        for (const x of args) this.sink(x, `promise resolution at ${locLabel(site)}`);
        return;
    }
    if (path.startsWith("console.")) {
      prim("undefined");
      return;
    }
    if (path.startsWith("Math.")) {
      prim("number");
      return;
    }
    if (path === "Date.now") {
      prim("number");
      return;
    }
    if (path.startsWith("Date.instance") || path === "Error.instance") {
      escapeAll();
      return;
    }
    void recvNode;
    escapeAll();
  }

  /** Re-run deferred field copies until nothing new flows. */
  finish(): void {
    for (;;) {
      const before = this.steps;
      for (const c of this.lateCopies) c();
      this.solve();
      if (this.steps === before || this.budgetExceeded) return;
    }
  }
}
