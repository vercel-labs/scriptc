import * as ts from "../ts7/adapter.js";
import {
  type IrExpr,
  type IrFunction,
  type IrType,
  callSiteReturnType,
  typeEquals,
} from "../../ir/ir.js";
import { everyStmtList, transformStmtList } from "../../ir/traverse.js";
import type { ClassInfo } from "./lower-classes.js";
import type { Lowerer } from "./lowerer.js";

type VirtualCall = IrExpr & { kind: "virtualCall" };

/** The most implementations a closed virtual call tests one by one before
 * it keeps the vtable's indirect call. */
const MAX_GUARDED_TARGETS = 4;

export interface DevirtualizeFacts {
  /** Bodies the reachability worklist retained. */
  reachable: ReadonlySet<string>;
  /** Classes with a constructor edge other than a subclass's super(). */
  instantiated: ReadonlySet<string>;
  /** LIBRARY mode: exported classes are open to the host. */
  library: boolean;
  files: readonly ts.SourceFile[];
}

/** Post-reachability devirtualization. A `virtualCall` on static class C
 * becomes a direct call when exactly one implementation can run:
 *
 * - no override of the nearest declaration is reachable below C (the
 *   original rule), or
 * - every class in C's subtree that may be instantiated EXACTLY resolves
 *   the method to the same declaration. Classes reached only through a
 *   subclass's super() never carry their own vtable, so an abstract base
 *   with one implementation, or a concrete base that is never itself
 *   constructed, dispatches to its single constructed implementation.
 *
 * Instantiation is conservative: any constructor edge other than super()
 * counts (`new`, class values, dynamic and library construction), as does
 * every class some retained IR allocates (`new`) or exposes as a class
 * value (its whole subtree: a construct thunk exists for it). Those are
 * the only native allocation paths; runtime-provided classes always
 * count. Subtrees whose classes the compiler cannot see completely
 * (decorated classes, dynamic bases, exported library classes) stay
 * virtual. Methods replaceable at runtime never reach this pass: their
 * calls take the checked property path instead of a virtualCall. */
export function devirtualizeVirtualCalls(
  lowerer: Lowerer,
  functions: IrFunction[],
  facts: DevirtualizeFacts,
): void {
  const sites = new ConstructedClasses(lowerer, functions, facts);
  for (const fn of functions)
    fn.body = transformStmtList(fn.body, {
      stmt: (statement) => statement,
      expr: (expression) =>
        expression.kind === "virtualCall" ? sites.devirtualize(expression) : expression,
    });
}

class ConstructedClasses {
  private readonly lowered = new Set<string>();
  /** Lowered bodies' return types: an override may return a subclass
   * (`set(): this` resolves per declaring class). */
  private readonly returnTypes = new Map<string, IrType>();
  /** Classes some retained IR allocates or exposes as a class value. */
  private readonly allocated = new Set<string>();
  private readonly exportedNames: ReadonlySet<string>;
  private readonly openMemo = new Map<ClassInfo, boolean>();
  private readonly subtreeMemo = new Map<ClassInfo, ClassInfo[]>();

  constructor(
    private readonly lowerer: Lowerer,
    functions: readonly IrFunction[],
    private readonly facts: DevirtualizeFacts,
  ) {
    const subtree = (name: string): void => {
      this.allocated.add(name);
      const info = lowerer.classes.get(name);
      if (info) for (const c of this.descendants(info)) this.allocated.add(c.def.name);
    };
    for (const fn of functions) {
      this.lowered.add(fn.name);
      this.returnTypes.set(fn.name, callSiteReturnType(fn));
      everyStmtList(fn.body, {
        stmt: () => true,
        expr: (e) => {
          if (e.kind === "new") this.allocated.add(e.className);
          else if (e.kind === "classRef") subtree(e.className);
          else if (e.kind === "newValue" && e.callee.type.kind === "classval")
            subtree(e.callee.type.className);
          return true;
        },
      });
    }
    this.exportedNames = facts.library ? exportedNames(facts.files) : new Set();
  }

  devirtualize(e: VirtualCall): IrExpr {
    const lowerer = this.lowerer;
    const info = lowerer.classes.get(e.className);
    const nearest = info && lowerer.findMethodOn(info, e.method);
    if (!info || !nearest) return e;
    if (
      nearest.sig.abstract !== true &&
      !this.descendants(info).some(
        (candidate) =>
          candidate !== info &&
          candidate.methods.has(e.method) &&
          this.facts.reachable.has(`%${candidate.def.name}.${e.method}`),
      )
    )
      return this.direct(e, info, nearest.declarer) ?? e;
    if (this.open(info)) return e;
    const targets: ClassInfo[] = [];
    for (const candidate of this.descendants(info)) {
      if (!this.mayInstantiate(candidate)) continue;
      const found = lowerer.findMethodOn(candidate, e.method);
      if (!found || found.sig.abstract === true) return e;
      if (runtimeProvided(candidate) || runtimeProvided(found.declarer)) return e;
      if (!targets.includes(found.declarer)) targets.push(found.declarer);
    }
    if (targets.length === 0) return e;
    for (const target of targets) {
      const callee = `%${target.def.name}.${e.method}`;
      if (!this.facts.reachable.has(callee) || !this.lowered.has(callee)) return e;
    }
    if (targets.length === 1) return this.direct(e, info, targets[0]!) ?? e;
    // A small closed set: the backend tests the loaded slot against each
    // implementation and calls it directly (no indirect fallback; every
    // instance that can reach this site resolves to one of them).
    if (targets.length > MAX_GUARDED_TARGETS) return e;
    return { ...e, targets: targets.map((t) => t.def.name) };
  }

  /** The direct call, or null when the target's return type cannot stand
   * for the site's: an override returning a subclass object (a polymorphic
   * `this` return) upcasts to the site's class; any other mismatch keeps
   * the virtual call. */
  private direct(e: VirtualCall, info: ClassInfo, target: ClassInfo): IrExpr | null {
    const callee = `%${target.def.name}.${e.method}`;
    const ret = this.returnTypes.get(callee) ?? e.type;
    const upcast =
      !typeEquals(ret, e.type) &&
      ret.kind === "object" &&
      e.type.kind === "object" &&
      this.lowerer.isSubclassOf(ret.className, e.type.className);
    if (!typeEquals(ret, e.type) && !upcast) return null;
    const receiver = e.args[0]!;
    const typed: IrExpr =
      target === info || this.lowerer.isSubclassOf(info.def.name, target.def.name)
        ? this.lowerer.upcastTo(receiver, target.def.name)
        : // Every instance that can reach this site is a `target`: the
          // reinterpret is proven by the instantiation set, like a
          // checker-narrowed downcast.
          {
            kind: "downcast",
            value: receiver,
            type: { kind: "object", className: target.def.name },
            loc: receiver.loc,
          };
    const call: IrExpr = {
      kind: "call",
      callee,
      args: [typed, ...e.args.slice(1)],
      type: ret,
      loc: e.loc,
    };
    return upcast && e.type.kind === "object"
      ? this.lowerer.upcastTo(call, e.type.className)
      : call;
  }

  /** The class and every class below it, in the isSubclassOf sense
   * (generic instances included). */
  private descendants(info: ClassInfo): ClassInfo[] {
    let out = this.subtreeMemo.get(info);
    if (out === undefined) {
      out = [info];
      for (const candidate of this.lowerer.classes.values())
        if (this.lowerer.isSubclassOf(candidate.def.name, info.def.name)) out.push(candidate);
      this.subtreeMemo.set(info, out);
    }
    return out;
  }

  private mayInstantiate(info: ClassInfo): boolean {
    return (
      this.facts.instantiated.has(info.def.name) ||
      this.allocated.has(info.def.name) ||
      runtimeProvided(info)
    );
  }

  /** True when C's subtree may hold instances the compiler cannot
   * enumerate: a decorator can replace a class, a dynamic base can change
   * the chain, and a library host can construct exported classes. */
  private open(info: ClassInfo): boolean {
    const memo = this.openMemo.get(info);
    if (memo !== undefined) return memo;
    const open = this.descendants(info).some(
      (c) =>
        c.classDecorators !== undefined ||
        c.callableBase !== undefined ||
        c.factoryBaseExpression !== undefined ||
        c.localClass?.baseExpression !== undefined ||
        (this.facts.library && this.exported(c)),
    );
    this.openMemo.set(info, open);
    return open;
  }

  private exported(info: ClassInfo): boolean {
    const decl = info.decl;
    if (!decl) return false;
    if ((ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Export) !== 0) return true;
    const name =
      decl.name?.text ??
      (ts.isVariableDeclaration(decl.parent) && ts.isIdentifier(decl.parent.name)
        ? decl.parent.name.text
        : undefined);
    if (name === undefined) return false;
    if (ts.isVariableDeclaration(decl.parent)) {
      const statement = decl.parent.parent?.parent;
      if (
        statement !== undefined &&
        ts.isVariableStatement(statement) &&
        (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export) !== 0
      )
        return true;
    }
    return this.exportedNames.has(name);
  }
}

function runtimeProvided(info: ClassInfo): boolean {
  return (
    info.decl === null ||
    info.builtinError === true ||
    info.builtinEmitter === true ||
    info.builtinStream !== undefined
  );
}

/** Local names a module exports through `export { ... }` or
 * `export default name` (declarations carry their own modifier). */
function exportedNames(files: readonly ts.SourceFile[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const sf of files)
    for (const statement of sf.statements.nodes) {
      if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier === undefined &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const element of statement.exportClause.elements.nodes)
          names.add((element.propertyName ?? element.name).text);
      } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
        names.add(statement.expression.text);
      }
    }
  return names;
}
