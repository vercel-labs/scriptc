/* Import-cycle initialization state: module bindings of a cycle that some
 * read or write can reach before their declarations ran
 * (cycleEarlyBindings) get a BOOL initialization flag. The declaring
 * module's %init sets the flag right after the declaration's store, and
 * every access from code that can run earlier checks it first — Node's
 * temporal-dead-zone ReferenceError, with the same message. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
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
import { everyStmt, transformStmtList } from "../../ir/traverse.js";

/** One flagged binding: its storage, its flag, and the module bodies whose
 * top-level code only runs after the declaration (no check needed). */
export interface CycleInitFlag {
  global: IrGlobal;
  flagId: string;
  name: string;
  /** The declaring module. */
  module: ts.SourceFile;
  settled: ReadonlySet<ts.SourceFile>;
  /** True for a binding of an import cycle. A binding flagged only for its
   * own module's early calls is checked opportunistically: whatever cannot
   * be checked keeps the unchecked behavior instead of refusing. */
  cycle: boolean;
}

/** Registers the initialization flags after global collection. Bindings
 * whose early access has no exact representation are refused: a `var`
 * (Node reads `undefined` there, but module storage only starts when the
 * declaring module's body starts), a class (its references are static), a
 * binding without module storage, or one with a use the lowering resolves
 * from the binding's type (a property key, a `typeof` operand). */
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
      refuse(binding.reference, `the class ${where}`);
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
    const global = lowerer.globalsBySymbol.get(binding.symbol);
    if (global !== undefined && binding.folded === undefined) {
      registerInitFlag(lowerer, binding, global, false);
    }
  }
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
 * as PutValue does. The declaration's own store is never checked. */
export function checkCycleBindingAccesses(lowerer: Lowerer, mod: IrModule): void {
  if (lowerer.cycleInitFlags.size === 0) return;
  const fileOfInit = new Map<string, ts.SourceFile>();
  for (const [sf, name] of lowerer.initNameOf) fileOfInit.set(name, sf);
  for (const fn of mod.functions) rewriteFunction(lowerer, fn, fileOfInit.get(fn.name));
}

function rewriteFunction(
  lowerer: Lowerer,
  fn: IrFunction,
  initOf: ts.SourceFile | undefined,
): void {
  const active = new Map<string, CycleInitFlag>();
  for (const [id, flag] of lowerer.cycleInitFlags) {
    if (initOf === undefined || initOf === flag.module || !flag.settled.has(initOf)) {
      active.set(id, flag);
    }
  }
  if (active.size === 0) return;
  const produced = new WeakSet<object>();
  let temps = 0;
  const check = (flag: CycleInitFlag, loc: SrcLoc): IrStmt => {
    const expr: IrExpr = {
      kind: "intrinsic",
      name: "module.tdzCheck",
      args: [
        { kind: "varRef", localId: flag.flagId, type: BOOL, loc },
        { kind: "strLit", value: flag.name, type: STRING, loc },
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
  const transform = {
    expr: (e: IrExpr): IrExpr => {
      if (produced.has(e)) return e;
      if (e.kind !== "varRef" && e.kind !== "incDec" && e.kind !== "assignExpr") return e;
      const flag = active.get(e.localId);
      if (flag === undefined) return e;
      if (e.kind === "assignExpr") {
        const t = temp(e.value.type);
        const value: IrExpr = { kind: "varRef", localId: t, type: e.value.type, loc: e.loc };
        const write: IrExpr = { ...e, value };
        produced.add(write);
        return {
          kind: "seqExpr",
          stmts: [{ kind: "varDecl", localId: t, init: e.value, loc: e.loc }, check(flag, e.loc)],
          result: write,
          type: e.type,
          loc: e.loc,
        };
      }
      produced.add(e);
      return { kind: "seqExpr", stmts: [check(flag, e.loc)], result: e, type: e.type, loc: e.loc };
    },
    stmt: (s: IrStmt): IrStmt => {
      if (produced.has(s) || s.kind !== "assign" || s.initializes) return s;
      const flag = active.get(s.localId);
      if (flag === undefined) return s;
      const t = temp(s.value.type);
      const write: IrStmt = {
        kind: "assign",
        localId: s.localId,
        value: { kind: "varRef", localId: t, type: s.value.type, loc: s.loc },
        loc: s.loc,
      };
      produced.add(write);
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
  if (initOf === undefined) {
    fn.body = transformStmtList(fn.body, transform);
    return;
  }
  // A module %init: its own bindings stop needing checks once the
  // top-level statement setting their flag completed.
  fn.body = fn.body.map((s) => {
    if (active.size === 0) return s;
    const out = transformStmtList([s], transform)[0]!;
    for (const [id, flag] of [...active]) {
      if (flag.module !== initOf) continue;
      const sets = !everyStmt(out, {
        expr: () => true,
        stmt: (inner) => !(inner.kind === "assign" && inner.localId === flag.flagId),
      });
      if (sets) active.delete(id);
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
  classes: readonly { baseValueGlobal?: string; symbolFields?: { globalId: string }[] }[],
): void {
  if (lowerer.cycleInitFlags.size === 0) return;
  for (const cls of classes) {
    const ids = [cls.baseValueGlobal, ...(cls.symbolFields ?? []).map((f) => f.globalId)];
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
