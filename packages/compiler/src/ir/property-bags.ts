import { dynUndefinedExpr } from "./build.js";
import {
  exprFunctionReference,
  FUNCTION_REFERENCE_KINDS,
  moduleFunctionReferences,
} from "./function-references.js";
import { dynamicFieldStores } from "./int32-slots.js";
import {
  DYN_CLASS_PROPERTIES,
  type IrClassDef,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
} from "./ir.js";
import { eachNodeOfKinds, type IrNodeIndex, type IrNodeKind } from "./node-index.js";
import { transformStmtList } from "./traverse.js";

/** The nodes the bag analysis reads: stores of a bag, calls and function
 * references. */
const BAG_FACT_KINDS: readonly IrNodeKind[] = ["fieldSet", "call", ...FUNCTION_REFERENCE_KINDS];

/** Names of the lowering's lazily created property-bag accessors
 * (class-dynamic-dispatch.ts). Only direct calls reach them. */
function isPropertyBagHelper(name: string): boolean {
  return name.startsWith("%dyn.class.") || name.startsWith("%class.properties:");
}

/** A receiver whose evaluation has no effect, so a read of it may be dropped. */
function pureReceiver(expr: IrExpr): boolean {
  if (expr.kind === "varRef") return true;
  if (expr.kind === "downcast" || expr.kind === "unionNarrow") return pureReceiver(expr.value);
  return false;
}

/** Drops the hidden property bag (DYN_CLASS_PROPERTIES) of the classes whose
 * bag nothing stores.
 *
 * A class whose instances reach checked-dynamic code gets the bag throughout
 * its hierarchy. The bag holds the properties that dynamic stores add to an
 * instance. Two things store it: the lazy initializers of the storing
 * property-bag accessors (a `fieldSet` of the bag), and the commit of a live
 * view after a runtime store into the view (dynamicFieldStores audits those
 * stores). When the program has no dynamic store and no called function
 * stores a hierarchy's bag, the bag stays undefined: the hierarchy's classes
 * keep no slot for it, its reads are undefined, and the uncalled storing
 * accessors are removed. Library builds keep every bag. `nodes`, an index
 * of `mod`, gives the nodes the analysis reads without walking the bodies. */
export function dropUnwrittenPropertyBags(mod: IrModule, nodes?: IrNodeIndex): IrModule {
  if (mod.lib !== undefined) return mod;
  const classes = mod.classes ?? [];
  if (!classes.some((cls) => cls.fields.some((field) => field.name === DYN_CLASS_PROPERTIES)))
    return mod;
  const stores = dynamicFieldStores(mod, undefined, undefined, nodes);
  if (stores.all || stores.names.size > 0) return mod;

  const byName = new Map(classes.map((cls) => [cls.name, cls]));
  // The bag sits at one offset throughout a hierarchy: it is kept or dropped
  // for the whole hierarchy below its topmost compiled class.
  const rootOf = (name: string): string => {
    let current = byName.get(name);
    while (current?.base !== undefined) {
      const base = byName.get(current.base);
      if (!base || base.runtime) break;
      current = base;
    }
    return current?.name ?? name;
  };

  const called = new Set(moduleFunctionReferences(mod));
  const writes = new Map<string, Set<string>>();
  const scan = nodes?.scan(BAG_FACT_KINDS);
  for (const fn of mod.functions) {
    eachNodeOfKinds(fn, scan, (node, statement) => {
      if (statement) {
        const stmt = node as IrStmt;
        if (stmt.kind === "fieldSet" && stmt.field === DYN_CLASS_PROPERTIES) {
          const written = writes.get(fn.name) ?? new Set<string>();
          written.add(rootOf(stmt.className));
          writes.set(fn.name, written);
        }
        return;
      }
      const expr = node as IrExpr;
      if (expr.kind === "call" && expr.callee !== fn.name) called.add(expr.callee);
      const referenced = exprFunctionReference(expr);
      if (referenced !== undefined) called.add(referenced);
    });
  }
  // Field presence tracking (JavaScript classes) keeps the bag it records into.
  const kept = new Set(classes.filter((cls) => cls.tracksOwnFields).map((cls) => rootOf(cls.name)));
  const removed = new Set<string>();
  for (const [name, roots] of writes) {
    if (called.has(name) || !isPropertyBagHelper(name)) for (const root of roots) kept.add(root);
    else removed.add(name);
  }
  const dropped = new Set(
    classes
      .filter(
        (cls) =>
          cls.fields.some((field) => field.name === DYN_CLASS_PROPERTIES) &&
          !kept.has(rootOf(cls.name)),
      )
      .map((cls) => cls.name),
  );
  if (dropped.size === 0) return mod;

  const transform = {
    expr: (expr: IrExpr): IrExpr => {
      if (
        expr.kind !== "fieldGet" ||
        expr.field !== DYN_CLASS_PROPERTIES ||
        !dropped.has(expr.className)
      )
        return expr;
      const undefinedBag = dynUndefinedExpr(expr.loc);
      if (pureReceiver(expr.obj)) return undefinedBag;
      return {
        kind: "seqExpr",
        stmts: [{ kind: "exprStmt", expr: expr.obj, loc: expr.loc }],
        result: undefinedBag,
        type: undefinedBag.type,
        loc: expr.loc,
      };
    },
    stmt: (stmt: IrStmt): IrStmt => stmt,
  };
  const functions = mod.functions
    .filter((fn) => !removed.has(fn.name))
    .map((fn): IrFunction => ({ ...fn, body: transformStmtList(fn.body, transform) }));
  return {
    ...mod,
    classes: classes.map((cls): IrClassDef =>
      dropped.has(cls.name)
        ? { ...cls, fields: cls.fields.filter((field) => field.name !== DYN_CLASS_PROPERTIES) }
        : cls,
    ),
    functions,
  };
}
