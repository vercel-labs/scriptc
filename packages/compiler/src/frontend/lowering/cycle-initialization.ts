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
 * declaring module's body starts), a binding without module storage, or
 * one with a use the lowering resolves from the binding's type (a
 * property key, a `typeof` operand). A class gets a flag like the
 * let/const bindings do — generic families included, and an `extends`
 * clause in another module checks it where that class statement runs. */
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
      // A class whose collection was deferred (a field type that only a
      // reference's retry admits) has no record yet. This check is such a
      // reference: the class registers now, or reports its own diagnostics
      // and is refused as a class, not as a cycle.
      const deferred = lowerer.deferredDiags.has(binding.symbol);
      if (deferred) lowerer.flushDeferred(binding.symbol);
      const info = lowerer.classBySymbol.get(binding.symbol);
      if (info !== undefined) {
        registerClassInitFlag(lowerer, binding, info, true);
        // Another module's `extends` clause reads the class value when
        // that module's class statement runs: the subclass's layout is
        // static, so the check goes at that statement (withClassInitFlag).
        const flag = lowerer.classInitFlags.get(info.def.name);
        if (flag !== undefined)
          for (const decl of earlyHeritageReferences(lowerer, binding)) {
            // A class EXPRESSION has no statement whose place the check can
            // take, so its heritage read keeps the fence.
            if (!ts.isClassDeclaration(decl)) {
              refuse(decl, `the class ${where}`);
              continue;
            }
            const checks = lowerer.heritageClassChecks.get(decl) ?? [];
            if (!checks.includes(flag)) checks.push(flag);
            lowerer.heritageClassChecks.set(decl, checks);
          }
      } else if (!deferred) {
        refuse(binding.reference, `the class ${where}`);
      }
      continue;
    }
    const global = lowerer.globalsBySymbol.get(binding.symbol);
    if (global === undefined) {
      // A binding the lowering resolves without storage (a promisified
      // library function: its calls lower directly). When every reference
      // to it is a call, each call checks a flag of its own first.
      if (binding.kind !== "lexical" || !registerCalledBindingFlag(lowerer, binding))
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

/** A cycle binding with no module storage whose every reference is the
 * callee of a call (`const read = promisify(fs.readFile)` and `read(path)`
 * in the module's functions): the flag is set when the declaring statement
 * completed, and the IR of each call checks it before anything else of the
 * call runs, as Node reads the callee before the arguments. False when a
 * reference is in any other position: its IR has no one form to check. */
function registerCalledBindingFlag(lowerer: Lowerer, binding: CycleEarlyBinding): boolean {
  const stmt = declaringStatement(binding.name);
  if (stmt === null) return false;
  const declaration = binding.name.parent;
  const references: ClassReference[] = [];
  for (const sf of lowerer.program.getImplementationSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const names = classLocalNames(lowerer, sf, binding.symbol, binding.name.text, true);
    if (names.size === 0) continue;
    const identifiers = fileIdentifiers(lowerer, sf);
    for (const text of names) {
      for (const { node } of identifiers.get(text) ?? []) {
        if (within(node, declaration) || !resolvesTo(lowerer, node, binding.symbol, true)) continue;
        const parent = node.parent;
        // Import and export lists name the binding without reading it.
        if (
          parent !== undefined &&
          (ts.isImportSpecifier(parent) ||
            ts.isExportSpecifier(parent) ||
            ts.isImportClause(parent))
        )
          continue;
        if (parent === undefined || !ts.isCallExpression(parent) || parent.expression !== node)
          return false;
        references.push({ loc: locOf(parent), name: node.text });
      }
    }
  }
  const index = lowerer.calledBindingInitFlags.length;
  const flagId = `%g.called.${index}.${binding.name.text}%initialized`;
  const global: IrGlobal = { id: flagId, name: "%initialized", type: BOOL, mutable: true };
  lowerer.globalsList.push(global);
  const flag: CycleInitFlag = {
    global,
    flagId,
    name: binding.name.text,
    module: binding.module,
    settled: binding.settled,
    cycle: true,
    references,
  };
  lowerer.calledBindingInitFlags.push(flag);
  const list = lowerer.cycleInitDeclarations.get(stmt) ?? [];
  list.push(flag);
  lowerer.cycleInitDeclarations.set(stmt, list);
  return true;
}

/** The call of a storage-less binding that `loc`'s IR is, or undefined. */
function calledReference(flag: CycleInitFlag, loc: SrcLoc): ClassReference | undefined {
  return (flag.references ?? []).find(
    (r) => r.loc.file === loc.file && r.loc.start === loc.start && r.loc.end === loc.end,
  );
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

/** The classes, in modules that can run before `binding`'s class statement,
 * whose `extends` clause (or another heritage expression) reads the class
 * value. Node evaluates the clause when that class statement runs, so the
 * reference is a read of the binding at that point; the compiled subclass
 * is static, so its statement carries the initialization check. */
function earlyHeritageReferences(
  lowerer: Lowerer,
  binding: CycleEarlyBinding,
): ts.ClassLikeDeclaration[] {
  const declaration = binding.name.parent;
  const out: ts.ClassLikeDeclaration[] = [];
  for (const sf of lowerer.program.getImplementationSourceFiles()) {
    if (sf.isDeclarationFile || binding.settled.has(sf)) continue;
    const names = classLocalNames(lowerer, sf, binding.symbol, binding.name.text, true);
    if (names.size === 0) continue;
    ts.walkPreorder(sf, (node) => {
      if (node === declaration) return "skip";
      // Only an `extends` clause is EVALUATED: an `implements` clause and a
      // heritage TYPE (`extends Base<C>`) name types, which Node erases, so
      // no read of the class happens there.
      if (!ts.isHeritageClause(node) || node.token !== ts.SyntaxKind.ExtendsKeyword)
        return undefined;
      let found = false;
      for (const base of node.types.nodes) {
        if (found) break;
        if (!ts.isExpressionWithTypeArguments(base)) continue;
        // The check runs BEFORE the statement's own expression, so it is
        // exact only where the heritage expression IS the read: a bare
        // identifier (parenthesized, asserted) or a namespace member. Any
        // other expression — a conditional, a call, a factory argument —
        // performs work first, which Node runs before it reaches the class;
        // pre-empting it with the ReferenceError would be a lie, so those
        // shapes keep their unchecked read. A type argument is erased and
        // never read at all.
        const reference = bareHeritageReference(base.expression);
        if (
          reference !== null &&
          names.has(reference.text) &&
          resolvesTo(lowerer, reference, binding.symbol, true)
        )
          found = true;
      }
      if (found) {
        const cls = enclosingClass7(node);
        // In the declaring module the statements run in source order: a
        // subclass below the declaration reads an initialized class.
        const after =
          sf === binding.module &&
          declaration !== undefined &&
          ts.tokenStartOfNode(cls ?? node) > ts.tokenStartOfNode(declaration);
        if (cls !== null && !after && !out.includes(cls)) out.push(cls);
      }
      return "skip";
    });
  }
  return out;
}

/** The identifier a heritage expression reads AS ITS WHOLE VALUE: the base
 * name, unwrapped from parentheses, assertions and non-null marks, or the
 * member of a namespace access (`ns.Base`). Null when the expression does
 * any work of its own first. */
function bareHeritageReference(expression: ts.Expression): ts.Identifier | null {
  let e: ts.Expression = expression;
  for (;;) {
    if (
      ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isSatisfiesExpression(e)
    ) {
      e = e.expression;
      continue;
    }
    break;
  }
  if (ts.isIdentifier(e)) return e;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) return e.name;
  return null;
}

/** The class-like declaration a heritage clause belongs to. */
function enclosingClass7(node: ts.Node): ts.ClassLikeDeclaration | null {
  for (let p: ts.Node | undefined = node; p !== undefined; p = p.parent)
    if (ts.isClassLikeDeclaration(p)) return p;
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
  if (ts.sourceTextIncludes(sf, declared)) names.add(declared);
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
 * its initialization flag when it has one. A statement whose own `extends`
 * clause reads a flagged class checks that flag first — Node evaluates the
 * clause before everything else the statement runs. */
export function withClassInitFlag(lowerer: Lowerer, info: ClassInfo, stmts: IrStmt[]): IrStmt[] {
  const loc = info.decl ? locOf(info.decl) : (stmts[0]?.loc ?? { file: "", start: 0, end: 0 });
  // A decorated class evaluates its decorator factories before it reads the
  // heritage: its checks go inside that sequence (lowerClassDecoration),
  // not before it.
  const decorationsFirst =
    info.classDecorators !== undefined &&
    !info.classDecorators.poisoned &&
    info.classDecorators.shapes !== undefined;
  // A generic class's instantiations share the declaration; the family is
  // the class whose statement runs, so only it emits the checks.
  const checks =
    !decorationsFirst && info.decl != null && info.genericInstance === undefined
      ? lowerer.heritageClassChecks.get(info.decl)
      : undefined;
  const flag = lowerer.classInitFlags.get(info.def.name);
  if (checks === undefined && flag === undefined) return stmts;
  const body: IrStmt[] = [
    ...(checks ?? []).map((base) => classInitCheck(base, loc)),
    ...stmts,
    ...(flag === undefined ? [] : [setFlag(flag, loc)]),
  ];
  return [{ kind: "block", body, loc }];
}

/** The checks a class statement emits for the cycle classes its `extends`
 * clause reads, at `loc` (the statement). A decorated class calls this from
 * its decoration sequence, after the decorator factories Node evaluates
 * first; every other class gets them at the head of its statement
 * (withClassInitFlag). */
export function heritageChecksFor(
  lowerer: Lowerer,
  decl: ts.ClassLikeDeclaration,
  loc: SrcLoc,
): IrStmt[] {
  const checks = lowerer.heritageClassChecks.get(decl);
  return checks === undefined ? [] : checks.map((flag) => classInitCheck(flag, loc));
}

/** The check of a flagged class's initialization, throwing Node's
 * ReferenceError naming the reference's own spelling. */
function classInitCheck(flag: CycleInitFlag, loc: SrcLoc): IrStmt {
  const name = coveredReference(flag, loc)?.name ?? flag.name;
  return {
    kind: "exprStmt",
    expr: {
      kind: "intrinsic",
      name: "module.tdzCheck",
      args: [
        { kind: "varRef", localId: flag.flagId, type: BOOL, loc },
        { kind: "strLit", value: name, type: STRING, loc },
      ],
      type: VOID,
      loc,
    },
    loc,
  };
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
  if (
    lowerer.cycleInitFlags.size === 0 &&
    lowerer.classInitFlags.size === 0 &&
    lowerer.calledBindingInitFlags.length === 0
  )
    return;
  const fileOfInit = new Map<string, ts.SourceFile>();
  for (const [sf, name] of lowerer.initNameOf) fileOfInit.set(name, sf);
  // Most functions run early, so the flags, classes and statics they check
  // are the same for all of them: build that state once instead of copying
  // every flagged binding per function.
  const shared = sharedCycleChecks(lowerer);
  for (const fn of mod.functions) {
    if (fn.name.startsWith(GENERATED_CLASS_HELPER)) continue;
    rewriteFunction(lowerer, fn, fileOfInit.get(fn.name), shared);
  }
  markUninitializedWrites(lowerer, mod);
}

/** The check state of a function that can run before any declaration: every
 * flag applies. Class members omit their own class's flag, whose state the
 * class's creation sets; the maps without each class's flag are built on the
 * first function of that class and reused by the rest. */
interface SharedCycleChecks {
  active: Map<string, CycleInitFlag>;
  classes: Map<string, CycleInitFlag>;
  statics: Map<string, CycleInitFlag[]>;
  called: readonly CycleInitFlag[];
  /** The class names, and the first segments of any that carry a dot: a
   * function name's class is its text between the leading `%` and the first
   * `.`, which is the whole name for an ordinary class. */
  classNames: ReadonlySet<string>;
  dottedHeads: ReadonlySet<string>;
  withoutClass: Map<
    string,
    { classes: Map<string, CycleInitFlag>; statics: Map<string, CycleInitFlag[]> }
  >;
}

function sharedCycleChecks(lowerer: Lowerer): SharedCycleChecks {
  const classes = new Map<string, CycleInitFlag>();
  const statics = new Map<string, CycleInitFlag[]>();
  for (const [className, flag] of lowerer.classInitFlags) {
    classes.set(className, flag);
    for (const id of flag.staticGlobals ?? NO_STATIC_GLOBALS)
      statics.set(id, [...(statics.get(id) ?? []), flag]);
  }
  const classNames = new Set<string>();
  const dottedHeads = new Set<string>();
  for (const name of lowerer.classInitFlags.keys()) {
    classNames.add(name);
    const dot = name.indexOf(".");
    if (dot > 0) dottedHeads.add(name.slice(0, dot));
  }
  return {
    active: lowerer.cycleInitFlags,
    classes,
    statics,
    called: lowerer.calledBindingInitFlags,
    classNames,
    dottedHeads,
    withoutClass: new Map(),
  };
}

/** The classes whose member function `fnName` is: the class itself, and a
 * dotted class name it is also a prefix of, as the per-function filter
 * (startsWith(`%$class.`)) would exclude both. */
function owningClasses(shared: SharedCycleChecks, fnName: string): string[] {
  if (!fnName.startsWith("%")) return [];
  const dot = fnName.indexOf(".", 1);
  if (dot < 0) return [];
  const head = fnName.slice(1, dot);
  const owners: string[] = [];
  if (shared.classNames.has(head)) owners.push(head);
  if (shared.dottedHeads.has(head)) {
    for (const name of shared.classNames) {
      if (name !== head && fnName.startsWith(`%${name}.`)) owners.push(name);
    }
  }
  return owners;
}

function classChecksWithout(
  shared: SharedCycleChecks,
  owners: readonly string[],
): { classes: Map<string, CycleInitFlag>; statics: Map<string, CycleInitFlag[]> } {
  const key = owners.join("\0");
  const cached = shared.withoutClass.get(key);
  if (cached !== undefined) return cached;
  const excluded = new Set<CycleInitFlag>();
  for (const name of owners) {
    const flag = shared.classes.get(name);
    if (flag !== undefined) excluded.add(flag);
  }
  const classes = new Map(shared.classes);
  for (const name of owners) classes.delete(name);
  const statics = new Map<string, CycleInitFlag[]>();
  for (const [id, flags] of shared.statics) {
    const rest = flags.filter((flag) => !excluded.has(flag));
    if (rest.length > 0) statics.set(id, rest);
  }
  const entry = { classes, statics };
  shared.withoutClass.set(key, entry);
  return entry;
}

/** The helpers class dispatch and class reflection generate
 * (class-dynamic-dispatch.ts, class-static-tables.ts): their IR is the
 * compiler's, not the program's, and carries the location of the class
 * declaration it derives from, which contains every reference that
 * declaration makes. Matching those locations against source references
 * would check a class the helper never reads (the static table of a class
 * whose getter names a subclass, guarded on the subclass). The source
 * references that reach a helper are checked where they are. */
const GENERATED_CLASS_HELPER = "%dyn.class.";

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
  /** Whether `body` holds a write to one of the bindings, which is what the
   * walk below marks; a function without one keeps its nodes as they are. */
  const marks = (body: readonly IrStmt[]): boolean => {
    let found = false;
    const expr = (e: IrExpr): boolean => {
      if (found) return false;
      if (e.kind === "assignExpr" && ids.has(e.localId)) found = true;
      return !found;
    };
    const stmt = (s: IrStmt): boolean => {
      if (found) return false;
      if (s.kind === "assign" && !s.initializes && ids.has(s.localId)) found = true;
      return !found;
    };
    for (const statement of body) {
      everyStmt(statement, { expr, stmt });
      if (found) return true;
    }
    return false;
  };
  for (const fn of mod.functions) {
    if (!marks(fn.body)) continue;
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
  shared: SharedCycleChecks,
): void {
  let active: Map<string, CycleInitFlag>;
  let classes: Map<string, CycleInitFlag>;
  let statics: Map<string, CycleInitFlag[]>;
  let called: readonly CycleInitFlag[];
  if (initOf === undefined) {
    // Every function that is not a module %init runs early: reuse the state
    // built once for the pass. A class's own members run only once the class
    // exists, or inside its own definition, where the inner binding is
    // initialized, so they omit their class's flag and its static storage.
    const owners = owningClasses(shared, fn.name);
    const filtered = owners.length === 0 ? null : classChecksWithout(shared, owners);
    active = shared.active;
    classes = filtered === null ? shared.classes : filtered.classes;
    statics = filtered === null ? shared.statics : filtered.statics;
    called = shared.called;
  } else {
    const runsEarly = (flag: CycleInitFlag): boolean =>
      initOf === flag.module || !flag.settled.has(initOf);
    active = new Map<string, CycleInitFlag>();
    for (const [id, flag] of lowerer.cycleInitFlags) {
      if (runsEarly(flag)) active.set(id, flag);
    }
    // Classes, by name, and the static field storage each reaches (a base
    // class's statics through a subclass too). A class's own members run
    // only once the class exists, or inside its own definition, where the
    // inner binding is initialized.
    const ownClasses = new Map<string, CycleInitFlag>();
    const ownStatics = new Map<string, CycleInitFlag[]>();
    for (const [className, flag] of lowerer.classInitFlags) {
      if (!runsEarly(flag) || fn.name.startsWith(`%${className}.`)) continue;
      ownClasses.set(className, flag);
      for (const id of flag.staticGlobals ?? NO_STATIC_GLOBALS)
        ownStatics.set(id, [...(ownStatics.get(id) ?? []), flag]);
    }
    classes = ownClasses;
    statics = ownStatics;
    // Bindings without storage, by the calls that name them.
    called = lowerer.calledBindingInitFlags.filter(runsEarly);
  }
  if (active.size === 0 && classes.size === 0 && called.length === 0) return;
  const flagOf = (localId: string, loc: SrcLoc): CycleInitFlag | undefined =>
    active.get(localId) ?? statics.get(localId)?.find((flag) => coversReference(flag, loc));
  const namesStatic = (flag: CycleInitFlag, fnName: string): boolean =>
    (flag.staticOwners ?? []).some((owner) => fnName.startsWith(`%${owner}.static:`));
  // A generic class's instantiations (`Box%<hex>`) are the class values
  // that construction and `instanceof` name; the binding the program reads
  // is the family (`Box`), which owns the initialization state.
  const familyFlagOf = (className: string): CycleInitFlag | undefined => {
    for (const [name, flag] of classes) {
      if (
        className.length > name.length &&
        className.startsWith(name) &&
        className[name.length] === "%"
      )
        return flag;
    }
    return undefined;
  };
  const classFlagOf = (e: IrExpr): CycleInitFlag | undefined => {
    if (classes.size === 0) return undefined;
    switch (e.kind) {
      case "new":
      case "classRef":
      case "instanceOf":
      case "caughtCheck": {
        const flag = classes.get(e.className) ?? familyFlagOf(e.className);
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
  // Most functions name no flagged binding: the walk below only asks whether
  // one node would be rewritten, and stops at the first that would, so a
  // function that holds none keeps its nodes as they are (rebuilt, they
  // would be identical).
  const wouldRewrite = (): boolean => {
    let found = false;
    const expr = (e: IrExpr): boolean => {
      if (found) return false;
      if (
        classFlagOf(e) !== undefined ||
        called.some((flag) => calledReference(flag, e.loc) !== undefined) ||
        ((e.kind === "varRef" || e.kind === "incDec" || e.kind === "assignExpr") &&
          flagOf(e.localId, e.loc) !== undefined)
      ) {
        found = true;
        return false;
      }
      return true;
    };
    const stmt = (s: IrStmt): boolean => {
      if (found) return false;
      if (s.kind === "assign" && !s.initializes && flagOf(s.localId, s.loc) !== undefined) {
        found = true;
        return false;
      }
      return true;
    };
    for (const statement of fn.body) {
      everyStmt(statement, { expr, stmt });
      if (found) return true;
    }
    return false;
  };
  if (!wouldRewrite()) return;
  let temps = 0;
  const check = (flag: CycleInitFlag, loc: SrcLoc): IrStmt => {
    // Node's ReferenceError names the binding the reference spells.
    const name =
      flag.className !== undefined
        ? (coveredReference(flag, loc)?.name ?? flag.name)
        : (calledReference(flag, loc)?.name ?? flag.localNames?.get(loc.file) ?? flag.name);
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
      // The IR of a call of a storage-less binding: the callee is read
      // before the arguments, so the check comes first.
      for (const flag of called) {
        if (calledReference(flag, e.loc) !== undefined)
          return {
            kind: "seqExpr",
            stmts: [check(flag, e.loc)],
            result: e,
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
    if (active.size === 0 && classes.size === 0 && called.length === 0) return s;
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
