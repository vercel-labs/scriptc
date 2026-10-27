/* Import-cycle initialization state: module bindings of a cycle that some
 * read or write can reach before their declarations ran
 * (cycleEarlyBindings) get a BOOL initialization flag. The declaring
 * module's %init sets the flag right after the declaration's store, and
 * every access from code that can run earlier checks it first — Node's
 * temporal-dead-zone ReferenceError, with the same message. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";
import {
  cycleEarlyBindings,
  locOf,
  moduleEarlyBindings,
  type CycleEarlyBinding,
} from "../program.js";
import { unsupportedDiag } from "../../diagnostics/diagnostic.js";
import {
  BOOL,
  STRING,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrGlobal,
  type IrModule,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { everyStmt, mapExprChildren, mapStmtChildren } from "../../ir/traverse.js";

/** One flagged binding: its storage, its flag, and the module bodies whose
 * top-level code only runs after the declaration (no check needed). */
export interface CycleInitFlag {
  global: IrGlobal;
  flagId: string;
  name: string;
  /** The declaring module. */
  module: ts.SourceFile;
  settled: ReadonlySet<ts.SourceFile>;
  /** Local names other files import the binding under, by file name. */
  localNames?: ReadonlyMap<string, string>;
  /** True for a binding of an import cycle. A binding flagged only for its
   * own module's early calls is checked opportunistically: whatever cannot
   * be checked keeps the unchecked behavior instead of refusing. */
  cycle: boolean;
  /** A pointer-guarded binding declared without an initializer: its
   * declaration initializes it (to undefined, which the pointer cannot
   * hold), so the flag alone decides its writes (markUninitializedWrites). */
  uninitialized?: true;
  /** A class binding: its references are the class's own IR forms and the
   * static members it reaches, its own and its bases' (`global` is the flag
   * itself). */
  className?: string;
  /** The class and its base classes, whose `%C.static:` functions a static
   * member access through the class can name. */
  staticOwners?: readonly string[];
  staticGlobals?: ReadonlySet<string>;
  /** The source references to the class outside its own body, with the
   * local name each one spells (an import can rename the class; Node's
   * ReferenceError names that binding). Only IR built for one of them is
   * checked: compiler-generated dispatch (error property helpers,
   * prototype data, reflection) also names the class and must keep
   * working before the class statement ran. */
  references?: readonly ClassReference[];
}

/** A source reference to a flagged class and the local name it spells. */
interface ClassReference {
  loc: SrcLoc;
  name: string;
}

/** The static field storage of a flag without a class. */
const NO_STATIC_GLOBALS: ReadonlySet<string> = new Set();

/** Registers the initialization flags after global collection. Bindings
 * whose early access has no exact representation are refused: a `var`
 * (Node reads `undefined` there, but module storage only starts when the
 * declaring module's body starts), a binding without module storage, a
 * class that another module's `extends` clause can reach early (the
 * subclass is static), or one with a use the lowering resolves from the
 * binding's type (a property key, a `typeof` operand). Other classes get a
 * flag like their module's early-reached classes. */
export function markCycleEarlyBindings(lowerer: Lowerer): void {
  const early = cycleEarlyBindings(
    lowerer.program,
    lowerer.entry,
    lowerer.moduleOrder,
    lowerer.forkTargets.length === 0 && lowerer.workerTargets.length === 0,
  );
  const refuse = (node: ts.Node, reason: string): void => {
    if (lowerer.remainder) return;
    lowerer.pushDiag(unsupportedDiag("SC1016", locOf(node), `circular imports (${reason})`));
  };
  for (const binding of early) {
    const where = `'${binding.name.text}' declared in ${binding.module.fileName} can be accessed before its declaration runs`;
    if (binding.kind === "var") {
      refuse(binding.reference, `the var binding ${where}, where Node reads undefined`);
      continue;
    }
    if (binding.kind === "class") {
      // The class's references from code that can run before its
      // statement check its initialization flag: Node's ReferenceError
      // only when the class is actually reached early.
      const info = lowerer.classBySymbol.get(binding.symbol);
      const heritage = earlyHeritageReference(lowerer, binding);
      if (info !== undefined && !info.generic && heritage === null)
        registerClassInitFlag(lowerer, binding, info, true);
      else refuse(heritage ?? binding.reference, `the class ${where}`);
      continue;
    }
    const global = lowerer.globalsBySymbol.get(binding.symbol);
    if (global === undefined) {
      refuse(binding.reference, `the binding ${where}, and it has no module storage to check`);
      continue;
    }
    if (binding.folded !== undefined) {
      refuse(
        binding.folded,
        `the binding ${where}, and this use is resolved from its type rather than its storage`,
      );
      continue;
    }
    registerInitFlag(lowerer, binding, global, true);
  }
  // A module's own function declarations are callable before its later
  // bindings are declared. Only bindings that such early-running code can
  // read get a flag; the others keep their unchecked storage.
  for (const binding of moduleEarlyBindings(lowerer.program, lowerer.moduleOrder)) {
    if (binding.kind === "class") {
      const info = lowerer.classBySymbol.get(binding.symbol);
      if (info !== undefined) registerClassInitFlag(lowerer, binding, info, false);
      continue;
    }
    const global = lowerer.globalsBySymbol.get(binding.symbol);
    if (global !== undefined && binding.folded === undefined) {
      registerInitFlag(lowerer, binding, global, false);
    }
  }
  // `let f: T;` with a pointer-guarded slot: once the declaration ran the
  // binding is initialized while the slot is still empty, so a write
  // checks the flag (where code can run before the declaration) instead of
  // the empty pointer. `f = () => f(...)` is the shape.
  for (const [id, entry] of lowerer.uninitializedLexicalGlobals) {
    const global = lowerer.globalsList.find((g) => g.id === id);
    if (global === undefined) continue;
    if (!lowerer.cycleInitFlags.has(id)) {
      registerInitFlag(
        lowerer,
        {
          symbol: entry.symbol,
          name: entry.name,
          kind: "lexical",
          module: entry.module,
          reference: entry.name,
          settled: new Set(),
        },
        global,
        false,
      );
    }
    lowerer.cycleInitFlags.get(id)!.uninitialized = true;
  }
}

/** A class that its module's early-running code can reach before the class
 * statement ran: the flag is set once the definition (static initializers
 * included) completed, and every reference from code that can run earlier
 * checks it — `new`, static member access, the class value and
 * `instanceof`. */
function registerClassInitFlag(
  lowerer: Lowerer,
  binding: CycleEarlyBinding,
  info: ClassInfo,
  cycle: boolean,
): void {
  const className = info.def.name;
  if (lowerer.classInitFlags.has(className)) return;
  const flagId = `%g.class.${className}%initialized`;
  const global: IrGlobal = { id: flagId, name: "%initialized", type: BOOL, mutable: true };
  lowerer.globalsList.push(global);
  const staticOwners: string[] = [];
  const staticGlobals = new Set<string>();
  for (let c: ClassInfo | null = info; c; c = c.base) {
    staticOwners.push(c.def.name);
    for (const field of c.staticFields) staticGlobals.add(field.globalId);
  }
  lowerer.classInitFlags.set(className, {
    global,
    flagId,
    name: binding.name.text,
    module: binding.module,
    settled: binding.settled,
    cycle,
    className,
    staticOwners,
    staticGlobals,
    references: classReferences(lowerer, binding.symbol, binding.name, cycle),
  });
}

/** A reference to a cycle class in another class's `extends` clause, in a
 * module that can run before the class statement: Node evaluates the clause
 * when that module's class statement runs, but the compiled subclass is
 * static and has no access to check. Null when there is none. */
function earlyHeritageReference(lowerer: Lowerer, binding: CycleEarlyBinding): ts.Node | null {
  const declaration = binding.name.parent;
  for (const sf of lowerer.program.getImplementationSourceFiles()) {
    if (sf.isDeclarationFile || sf === binding.module || binding.settled.has(sf)) continue;
    const names = classLocalNames(lowerer, sf, binding.symbol, binding.name.text, true);
    if (names.size === 0) continue;
    let found: ts.Node | null = null;
    ts.walkPreorder(sf, (node) => {
      if (found !== null || node === declaration) return "skip";
      if (!ts.isHeritageClause(node)) return undefined;
      // Node evaluates the whole clause when the class statement runs:
      // any reference inside it (parenthesized, a factory argument)
      // reaches the class.
      ts.walkPreorder(node, (inner) => {
        if (found !== null) return "skip";
        if (
          ts.isIdentifier(inner) &&
          names.has(inner.text) &&
          resolvesTo(lowerer, inner, binding.symbol, true)
        )
          found = inner;
        return undefined;
      });
      return "skip";
    });
    if (found !== null) return found;
  }
  return null;
}

/** The identifiers of `sf` by text, each with its position in the file's
 * preorder walk: one walk per file serves every class's reference scan. */
function fileIdentifiers(
  lowerer: Lowerer,
  sf: ts.SourceFile,
): ReadonlyMap<string, readonly { order: number; node: ts.Identifier }[]> {
  const memo = lowerer.program.analysis.fileIdentifiers;
  const known = memo.get(sf);
  if (known !== undefined) return known;
  const byText = new Map<string, { order: number; node: ts.Identifier }[]>();
  let order = 0;
  ts.walkPreorder(sf, (node) => {
    order++;
    if (!ts.isIdentifier(node)) return undefined;
    const list = byText.get(node.text);
    if (list === undefined) byText.set(node.text, [{ order, node }]);
    else list.push({ order, node });
    return undefined;
  });
  memo.set(sf, byText);
  return byText;
}

/** Whether `node` lies inside `ancestor` (or is it): the reference scans
 * skip the class's own declaration. */
function within(node: ts.Node, ancestor: ts.Node | undefined): boolean {
  if (ancestor === undefined) return false;
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent)
    if (current === ancestor) return true;
  return false;
}

/** Whether `node` names `symbol`, through import aliases when `aliases`. */
function resolvesTo(
  lowerer: Lowerer,
  node: ts.Identifier,
  symbol: ts.Symbol,
  aliases: boolean,
): boolean {
  let referenced = lowerer.checker.getSymbolAtLocation(node);
  if (aliases && referenced !== undefined && referenced.flags & ts.SymbolFlags.Alias)
    referenced = lowerer.checker.getAliasedSymbol(referenced);
  return referenced === symbol;
}

/** The local names under which `sf` can spell the class: its declared name
 * (when the file's text contains it) and, with `aliases`, the local names
 * of the file's imports that resolve to it (`import { Sink as Alias }`, a
 * default import, a re-exported name). */
function classLocalNames(
  lowerer: Lowerer,
  sf: ts.SourceFile,
  symbol: ts.Symbol,
  declared: string,
  aliases: boolean,
): Set<string> {
  const names = new Set<string>();
  if (sf.text.includes(declared)) names.add(declared);
  if (!aliases) return names;
  for (const statement of sf.statements.nodes) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    const locals: ts.Identifier[] = [];
    if (clause.name !== undefined) locals.push(clause.name);
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings))
      for (const element of bindings.elements.nodes) locals.push(element.name);
    for (const local of locals)
      if (!names.has(local.text) && resolvesTo(lowerer, local, symbol, true)) names.add(local.text);
  }
  return names;
}

/** The source spans of the identifiers naming the class outside its own
 * declaration, in every program file. For a class of an import cycle that
 * includes other modules' import bindings; another module's references to a
 * class flagged only for its own module's early calls always run after the
 * class statement. */
function classReferences(
  lowerer: Lowerer,
  symbol: ts.Symbol,
  name: ts.Identifier,
  cycle: boolean,
): ClassReference[] {
  const declaration = name.parent;
  const out: ClassReference[] = [];
  for (const sf of lowerer.program.getImplementationSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    // Another module names the class through its import bindings, under
    // the class's name or a local one.
    const names = classLocalNames(lowerer, sf, symbol, name.text, cycle);
    if (names.size === 0) continue;
    // The file's identifiers under those names, in walk order.
    const identifiers = fileIdentifiers(lowerer, sf);
    const named: { order: number; node: ts.Identifier }[] = [];
    for (const text of names) for (const entry of identifiers.get(text) ?? []) named.push(entry);
    if (names.size > 1) named.sort((a, b) => a.order - b.order);
    for (const { node } of named)
      if (!within(node, declaration) && resolvesTo(lowerer, node, symbol, cycle))
        out.push({ loc: locOf(node), name: node.text });
  }
  return out;
}

/** The source reference to the flagged class that `loc`'s IR was built
 * for, or undefined. */
function coveredReference(flag: CycleInitFlag, loc: SrcLoc): ClassReference | undefined {
  return (flag.references ?? []).find(
    (r) => r.loc.file === loc.file && loc.start <= r.loc.start && r.loc.end <= loc.end,
  );
}

/** Whether `loc` is the IR of a source reference to the flagged class. */
function coversReference(flag: CycleInitFlag, loc: SrcLoc): boolean {
  return coveredReference(flag, loc) !== undefined;
}

/** The class statement's static initialization, followed by the store of
 * its initialization flag when it has one. */
export function withClassInitFlag(lowerer: Lowerer, info: ClassInfo, stmts: IrStmt[]): IrStmt[] {
  const flag = lowerer.classInitFlags.get(info.def.name);
  if (flag === undefined) return stmts;
  const loc = info.decl ? locOf(info.decl) : (stmts[0]?.loc ?? { file: "", start: 0, end: 0 });
  return [{ kind: "block", body: [...stmts, setFlag(flag, loc)], loc }];
}

function registerInitFlag(
  lowerer: Lowerer,
  binding: CycleEarlyBinding,
  global: IrGlobal,
  cycle: boolean,
): void {
  if (lowerer.cycleInitFlags.has(global.id)) return;
  const flagId = `${global.id}%initialized`;
  lowerer.globalsList.push({ id: flagId, name: "%initialized", type: BOOL, mutable: true });
  global.initFlag = flagId;
  const flag: CycleInitFlag = {
    global,
    flagId,
    name: binding.name.text,
    module: binding.module,
    settled: binding.settled,
    ...(binding.localNames ? { localNames: binding.localNames } : {}),
    cycle,
  };
  lowerer.cycleInitFlags.set(global.id, flag);
  const stmt = declaringStatement(binding.name);
  if (stmt !== null) {
    const list = lowerer.cycleInitDeclarations.get(stmt) ?? [];
    list.push(flag);
    lowerer.cycleInitDeclarations.set(stmt, list);
  }
}

function declaringStatement(name: ts.Node): ts.Statement | null {
  for (let p: ts.Node | undefined = name.parent; p !== undefined; p = p.parent) {
    if (ts.isVariableStatement(p)) return p;
    if (ts.isSourceFile(p)) return null;
  }
  return null;
}

function setFlag(flag: CycleInitFlag, loc: SrcLoc): IrStmt {
  return {
    kind: "assign",
    localId: flag.flagId,
    value: { kind: "boolLit", value: true, type: BOOL, loc },
    loc,
  };
}

/** The declaring statement's IR with each flagged binding's flag set right
 * after the binding's first store (or after the whole statement when the
 * declaration stores nothing, as `let x;` can). */
export function withCycleInitFlags(
  lowerer: Lowerer,
  stmt: ts.Statement,
  lowered: IrStmt[],
): IrStmt[] {
  const flags = lowerer.cycleInitDeclarations.get(stmt);
  if (flags === undefined) return lowered;
  const pending = new Map(flags.map((f) => [f.global.id, f] as const));
  const place = (list: IrStmt[]): IrStmt[] => {
    const out: IrStmt[] = [];
    for (const s of list) {
      if (pending.size === 0) {
        out.push(s);
        continue;
      }
      if (s.kind === "assign" && pending.has(s.localId)) {
        out.push({ ...s, initializes: true }, setFlag(pending.get(s.localId)!, s.loc));
        pending.delete(s.localId);
        continue;
      }
      if (s.kind === "block") {
        out.push({ ...s, body: place(s.body) });
        continue;
      }
      out.push(s);
      // A store nested in another construct: the flag follows the construct.
      for (const [id, flag] of [...pending]) {
        let stores = false;
        let nested = false;
        everyStmt(s, {
          expr: (e) => {
            if (e.kind === "assignExpr" && e.localId === id) nested = true;
            return true;
          },
          stmt: (inner) => {
            if (inner.kind === "assign" && inner.localId === id) {
              (inner as { initializes?: true }).initializes = true;
              stores = true;
            }
            return true;
          },
        });
        if (nested && !flag.cycle) {
          // Unmarkable store of a same-module binding: keep it unchecked.
          lowerer.cycleInitFlags.delete(id);
        } else if (nested && !lowerer.remainder) {
          lowerer.pushDiag(
            unsupportedDiag(
              "SC1016",
              locOf(stmt),
              `circular imports (the declaration of '${flag.name}' stores it inside an expression, where its initialization cannot be marked)`,
            ),
          );
        }
        if (stores || nested) {
          out.push(setFlag(flag, s.loc));
          pending.delete(id);
        }
      }
    }
    return out;
  };
  const out = place(lowered);
  const loc = locOf(stmt);
  for (const flag of pending.values()) out.push(setFlag(flag, loc));
  return out;
}

/** Inserts the initialization checks into every function that can access a
 * flagged binding before its declaration ran: every function except the
 * %init bodies of settled modules, and in the declaring module's own %init
 * only the statements up to the one that sets the flag (earlier reads
 * there come from inlined callback bodies; tsc rejects direct ones). Reads
 * check before reading; writes check after evaluating the assigned value,
 * as PutValue does. A class is read where its reference evaluates: before
 * the arguments of `new K(...)` and `K.m(...)` and the value stored by
 * `K.x = v`, but after the left operand of `x instanceof K`. The
 * declaration's own store is never checked. */
export function checkCycleBindingAccesses(lowerer: Lowerer, mod: IrModule): void {
  if (lowerer.cycleInitFlags.size === 0 && lowerer.classInitFlags.size === 0) return;
  const fileOfInit = new Map<string, ts.SourceFile>();
  for (const [sf, name] of lowerer.initNameOf) fileOfInit.set(name, sf);
  for (const fn of mod.functions) rewriteFunction(lowerer, fn, fileOfInit.get(fn.name));
  markUninitializedWrites(lowerer, mod);
}

/** Writes to a binding declared without an initializer that run after its
 * declaration store into an initialized binding whose slot may still be
 * empty: the pointer guard must not refuse them. Writes that can run
 * earlier carry the flag check rewriteFunction inserted. An assignment in
 * expression position (`(f = v)`) becomes an initializing `assign` whose
 * value a temp holds and yields. */
function markUninitializedWrites(lowerer: Lowerer, mod: IrModule): void {
  const ids = new Set<string>();
  for (const [id, flag] of lowerer.cycleInitFlags) if (flag.uninitialized) ids.add(id);
  if (ids.size === 0) return;
  const mark = (s: IrStmt): IrStmt =>
    s.kind === "assign" && !s.initializes && ids.has(s.localId) ? { ...s, initializes: true } : s;
  for (const fn of mod.functions) {
    let temps = 0;
    const markExpr = (e: IrExpr): IrExpr => {
      if (e.kind !== "assignExpr" || !ids.has(e.localId)) return e;
      const t = `%uninitWrite.${temps++}`;
      fn.locals.push({ id: t, name: "%uninitWrite", type: e.value.type, mutable: false });
      const value: IrExpr = { kind: "varRef", localId: t, type: e.value.type, loc: e.loc };
      return {
        kind: "seqExpr",
        stmts: [
          { kind: "varDecl", localId: t, init: e.value, loc: e.loc },
          { kind: "assign", localId: e.localId, value, initializes: true, loc: e.loc },
        ],
        result: value,
        type: e.type,
        loc: e.loc,
      };
    };
    const rewriteExpr = (e: IrExpr): IrExpr =>
      markExpr(mapExprChildren(e, rewriteExpr, rewriteStmt));
    const rewriteStmt = (s: IrStmt): IrStmt => mark(mapStmtChildren(s, rewriteExpr, rewriteStmt));
    fn.body = fn.body.map(rewriteStmt);
  }
}

function rewriteFunction(
  lowerer: Lowerer,
  fn: IrFunction,
  initOf: ts.SourceFile | undefined,
): void {
  const active = new Map<string, CycleInitFlag>();
  const runsEarly = (flag: CycleInitFlag): boolean =>
    initOf === undefined || initOf === flag.module || !flag.settled.has(initOf);
  for (const [id, flag] of lowerer.cycleInitFlags) {
    if (runsEarly(flag)) active.set(id, flag);
  }
  // Classes, by name, and the static field storage each reaches (a base
  // class's statics through a subclass too). A class's own members run only
  // once the class exists, or inside its own definition, where the inner
  // binding is initialized.
  const classes = new Map<string, CycleInitFlag>();
  const statics = new Map<string, CycleInitFlag[]>();
  for (const [className, flag] of lowerer.classInitFlags) {
    if (!runsEarly(flag) || fn.name.startsWith(`%${className}.`)) continue;
    classes.set(className, flag);
    for (const id of flag.staticGlobals ?? NO_STATIC_GLOBALS)
      statics.set(id, [...(statics.get(id) ?? []), flag]);
  }
  if (active.size === 0 && classes.size === 0) return;
  const flagOf = (localId: string, loc: SrcLoc): CycleInitFlag | undefined =>
    active.get(localId) ?? statics.get(localId)?.find((flag) => coversReference(flag, loc));
  const namesStatic = (flag: CycleInitFlag, fnName: string): boolean =>
    (flag.staticOwners ?? []).some((owner) => fnName.startsWith(`%${owner}.static:`));
  const classFlagOf = (e: IrExpr): CycleInitFlag | undefined => {
    if (classes.size === 0) return undefined;
    switch (e.kind) {
      case "new":
      case "classRef":
      case "instanceOf":
      case "caughtCheck": {
        const flag = classes.get(e.className);
        return flag !== undefined && coversReference(flag, e.loc) ? flag : undefined;
      }
      case "call":
        for (const [className, flag] of classes) {
          if (
            (namesStatic(flag, e.callee) || e.callee === `%dyn.class.instanceof:${className}`) &&
            coversReference(flag, e.loc)
          )
            return flag;
        }
        return undefined;
      case "closure":
        // A static method read as a value (`const f = K.m`) reads K.
        for (const flag of classes.values())
          if (namesStatic(flag, e.fnName) && coversReference(flag, e.loc)) return flag;
        return undefined;
      default:
        return undefined;
    }
  };
  let temps = 0;
  const check = (flag: CycleInitFlag, loc: SrcLoc): IrStmt => {
    // Node's ReferenceError names the binding the reference spells.
    const name =
      flag.className !== undefined
        ? (coveredReference(flag, loc)?.name ?? flag.name)
        : (flag.localNames?.get(loc.file) ?? flag.name);
    const expr: IrExpr = {
      kind: "intrinsic",
      name: "module.tdzCheck",
      args: [
        { kind: "varRef", localId: flag.flagId, type: BOOL, loc },
        { kind: "strLit", value: name, type: STRING, loc },
      ],
      type: VOID,
      loc,
    };
    return { kind: "exprStmt", expr, loc };
  };
  const temp = (type: IrType): string => {
    const id = `%cycleInit.${temps++}`;
    fn.locals.push({ id, name: "%cycleInit", type, mutable: false });
    return id;
  };
  // Post-order: children are rewritten before their parent is wrapped, so
  // a wrapper is never visited again. (No identity set: compiled code
  // cannot key weak collections by IR records.)
  const wrap = {
    expr: (e: IrExpr): IrExpr => {
      const classFlag = classFlagOf(e);
      if (classFlag !== undefined) {
        // `x instanceof K` evaluates x before it reads K; `new K(...)` and
        // `K.m(...)` read K before their arguments.
        const left =
          e.kind === "instanceOf" || e.kind === "caughtCheck"
            ? e.value
            : e.kind === "call" && e.callee.startsWith("%dyn.class.instanceof:")
              ? e.args[0]
              : undefined;
        if (left === undefined || left.kind === "varRef")
          return {
            kind: "seqExpr",
            stmts: [check(classFlag, e.loc)],
            result: e,
            type: e.type,
            loc: e.loc,
          };
        const t = temp(left.type);
        const value: IrExpr = { kind: "varRef", localId: t, type: left.type, loc: left.loc };
        const test: IrExpr =
          e.kind === "call"
            ? { ...e, args: [value, ...e.args.slice(1)] }
            : e.kind === "instanceOf" || e.kind === "caughtCheck"
              ? { ...e, value }
              : e;
        return {
          kind: "seqExpr",
          stmts: [
            { kind: "varDecl", localId: t, init: left, loc: left.loc },
            check(classFlag, e.loc),
          ],
          result: test,
          type: e.type,
          loc: e.loc,
        };
      }
      if (e.kind !== "varRef" && e.kind !== "incDec" && e.kind !== "assignExpr") return e;
      const flag = flagOf(e.localId, e.loc);
      if (flag === undefined) return e;
      // `K.x = v` reads K before it evaluates v.
      if (e.kind === "assignExpr" && flag.className === undefined) {
        const t = temp(e.value.type);
        const value: IrExpr = { kind: "varRef", localId: t, type: e.value.type, loc: e.loc };
        const write: IrExpr = { ...e, value };
        return {
          kind: "seqExpr",
          stmts: [{ kind: "varDecl", localId: t, init: e.value, loc: e.loc }, check(flag, e.loc)],
          result: write,
          type: e.type,
          loc: e.loc,
        };
      }
      return { kind: "seqExpr", stmts: [check(flag, e.loc)], result: e, type: e.type, loc: e.loc };
    },
    stmt: (s: IrStmt): IrStmt => {
      if (s.kind !== "assign" || s.initializes) return s;
      const flag = flagOf(s.localId, s.loc);
      if (flag === undefined) return s;
      // `K.x = v` reads K before it evaluates v.
      if (flag.className !== undefined)
        return { kind: "block", body: [check(flag, s.loc), s], loc: s.loc };
      const t = temp(s.value.type);
      const write: IrStmt = {
        kind: "assign",
        localId: s.localId,
        value: { kind: "varRef", localId: t, type: s.value.type, loc: s.loc },
        ...(flag.uninitialized ? { initializes: true as const } : {}),
        loc: s.loc,
      };
      return {
        kind: "block",
        body: [
          { kind: "varDecl", localId: t, init: s.value, loc: s.loc },
          check(flag, s.loc),
          write,
        ],
        loc: s.loc,
      };
    },
  };
  const rewriteExpr = (e: IrExpr): IrExpr =>
    wrap.expr(mapExprChildren(e, rewriteExpr, rewriteStmt));
  const rewriteStmt = (s: IrStmt): IrStmt =>
    wrap.stmt(mapStmtChildren(s, rewriteExpr, rewriteStmt));
  const rewriteList = (list: IrStmt[]): IrStmt[] => list.map(rewriteStmt);
  if (initOf === undefined) {
    fn.body = rewriteList(fn.body);
    return;
  }
  // A module %init: its own bindings stop needing checks once the
  // top-level statement setting their flag completed.
  const setsFlag = (s: IrStmt, flag: CycleInitFlag): boolean =>
    !everyStmt(s, {
      expr: () => true,
      stmt: (inner) => !(inner.kind === "assign" && inner.localId === flag.flagId),
    });
  fn.body = fn.body.map((s) => {
    if (active.size === 0 && classes.size === 0) return s;
    // A class statement's own static initialization sees the inner
    // binding: its flag stops applying before that statement.
    for (const [className, flag] of [...classes]) {
      if (flag.module !== initOf || !setsFlag(s, flag)) continue;
      classes.delete(className);
      for (const id of flag.staticGlobals ?? NO_STATIC_GLOBALS) {
        const rest = statics.get(id)!.filter((other) => other !== flag);
        if (rest.length > 0) statics.set(id, rest);
        else statics.delete(id);
      }
    }
    const out = rewriteStmt(s);
    for (const [id, flag] of [...active]) {
      if (flag.module !== initOf) continue;
      if (setsFlag(out, flag)) active.delete(id);
    }
    return out;
  });
}

/** Class layouts that read module storage directly (an evaluated heritage
 * value, a symbol-keyed field) bypass the checks: refuse when that storage
 * is a flagged import-cycle binding, and leave a same-module binding
 * unchecked. */
export function refuseUncheckedCycleReads(
  lowerer: Lowerer,
  classes: readonly {
    baseValueGlobal?: string;
    symbolFields?: readonly ({ globalId: string } | { wellKnown: string })[];
  }[],
): void {
  if (lowerer.cycleInitFlags.size === 0) return;
  for (const cls of classes) {
    const ids = [
      cls.baseValueGlobal,
      ...(cls.symbolFields ?? []).map((f) => ("globalId" in f ? f.globalId : undefined)),
    ];
    for (const id of ids) {
      const flag = id === undefined ? undefined : lowerer.cycleInitFlags.get(id);
      if (flag === undefined) continue;
      if (!flag.cycle) {
        // A same-module binding whose storage a class layout reads keeps
        // the unchecked behavior: no check, and no refusal.
        lowerer.cycleInitFlags.delete(id!);
        continue;
      }
      if (lowerer.remainder) continue;
      const loc = flag.global.source?.loc ?? { file: lowerer.entry.fileName, start: 0, end: 0 };
      lowerer.pushDiag(
        unsupportedDiag(
          "SC1016",
          loc,
          `circular imports (the class layout reads '${flag.name}' directly, before an initialization check can run)`,
        ),
      );
    }
  }
}
