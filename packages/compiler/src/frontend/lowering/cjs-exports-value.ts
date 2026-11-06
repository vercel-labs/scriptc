/* A CommonJS module's exports object taken as a value.
 *
 * The compiled module system has no reflective exports object: each export
 * is a module global, and a requirer's `const m = require("./m.cjs")`
 * resolves members through the export table. A module that re-exports
 * another module's namespace (`var cst = require("./parse/cst.cjs");
 * exports.CST = cst;`) uses the namespace itself as a value, and its
 * requirers read `yaml.CST.parse(...)` through it.
 *
 * The value is the runtime's exports object (scr_cjs_exports.c): one plain
 * extensible object per module, with the module's export names as own
 * enumerable accessors in assignment order. Each accessor calls a compiled
 * getter that reads the export's module global, so the object is live — a
 * value the exporting module assigns after it finished evaluating is
 * visible — and every holder of the namespace sees the same object. */
import * as ts from "../ts7/adapter.js";
import { dynUndefinedExpr, strLit, varRef } from "../../ir/build.js";
import {
  arrayOf,
  funcOf,
  DYN,
  STRING,
  type IrExpr,
  type IrStmt,
  type SrcLoc,
} from "../../ir/ir.js";
import {
  cjsExportAssignmentOf,
  cjsExportDiscardReason,
  isModuleExportsAccess,
  locOf,
} from "../program.js";
import { newFnCtx, PoisonError, type Lowerer } from "./lowerer.js";
import {
  cjsExportValueByName,
  cjsHasLiveMemberExports,
  cjsTableMethodEntry,
  inlineProgramRequireOf,
  nestedCjsExportAssignmentsOf,
  splitRequireBindingOfIdent,
} from "./cjs-inline-require.js";

/** The export names an assignment chain attaches (`exports.a = exports.b =
 * value`), in the order Node attaches them: the rightmost assignment runs
 * first, so the innermost member becomes the object's first property. Null
 * when a link's name is not a plain identifier. */
function cjsExportChainNames(e: ts.BinaryExpression): string[] | null {
  const names: string[] = [];
  let cur: ts.Expression = e;
  for (;;) {
    while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    if (!ts.isBinaryExpression(cur) || cur.operatorToken.kind !== ts.SyntaxKind.EqualsToken) break;
    const left = cur.left;
    if (!ts.isPropertyAccessExpression(left) || left.questionDotToken) break;
    if (!ts.isIdentifier(left.name) || left.name.text === undefined) return null;
    const recv = left.expression;
    if (!((ts.isIdentifier(recv) && recv.text === "exports") || isModuleExportsAccess(recv))) break;
    names.push(left.name.text);
    cur = cur.right;
  }
  return names.reverse();
}

/** The names of a CommonJS module's `module.exports` object in assignment
 * order: the properties Node's require() callers find on it. The names come
 * from the module's own export table — its `exports.<name>` /
 * `module.exports.<name>` members and the properties of its table literal —
 * not from the named-import link check, whose namespace object also names
 * `default` and `module.exports` and stops at the names an ES module could
 * import. Statements a later `module.exports =` replaces are skipped
 * exactly as Node discards them.
 *
 * `proto` is the table literal's non-computed `__proto__` initializer: that
 * member sets the exports object's prototype as the literal is built (B.3.1)
 * instead of naming an export.
 *
 * Null when the table is not statically known: a computed name, a spread or
 * accessor in the table, or a replaced value that is not another program
 * module's exports — the caller keeps its refusal rather than publishing an
 * object with the wrong properties. */
function cjsExportsTableNames(
  lowerer: Lowerer,
  dep: ts.SourceFile,
  depth = 0,
): { owner: ts.SourceFile; names: string[]; proto: ts.Expression | null } | null {
  if (depth > 32 || !lowerer.moduleOrder.includes(dep)) return null;
  const stmts = dep.statements.nodes;
  // The kept whole replacement, if the module has one: its names are the
  // value's own properties.
  let kept: Extract<ReturnType<typeof cjsExportAssignmentOf>, { kind: "table" }> | null = null;
  for (const stmt of stmts) {
    if (cjsExportDiscardReason(stmt) !== null) continue;
    const cjs = cjsExportAssignmentOf(stmt);
    if (cjs?.kind === "table" && cjs.obj === null) kept = cjs;
  }
  if (kept !== null) {
    // Members attached to the replacement value (`module.exports.f = …`
    // after the assignment) extend the object this module exposes.
    if (cjsHasLiveMemberExports(lowerer, dep)) return null;
    let rhs: ts.Expression = kept.expr.right;
    while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
    const require = inlineProgramRequireOf(lowerer, rhs);
    const split =
      require === null && ts.isIdentifier(rhs) ? splitRequireBindingOfIdent(lowerer, rhs) : null;
    const target = require?.dep ?? split?.dep ?? null;
    // `module.exports = require("./m.cjs")` exposes the dependency's own
    // export table — the same object its direct requirers hold.
    if (target === null) return null;
    return cjsExportsTableNames(lowerer, target, depth + 1);
  }
  const names: string[] = [];
  let proto: ts.Expression | null = null;
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  };
  for (const stmt of stmts) {
    if (cjsExportDiscardReason(stmt) !== null) continue;
    const cjs = cjsExportAssignmentOf(stmt);
    // `const src = exports.src = []` and other top-level attachments in
    // value position export their name too. Inside a replaced table literal
    // they attach to the discarded object instead.
    if (cjs === null || cjs.kind === "member")
      for (const nested of nestedCjsExportAssignmentsOf(stmt, cjs?.expr)) add(nested.name.text);
    if (cjs === null) continue;
    if (cjs.kind === "member") {
      if (!ts.isIdentifier(cjs.name)) return null;
      const chain = cjsExportChainNames(cjs.expr);
      if (chain === null) return null;
      for (const name of chain) add(name);
      continue;
    }
    if (cjs.obj === null) return null;
    for (const prop of cjs.obj.properties.nodes) {
      if (ts.isShorthandPropertyAssignment(prop)) {
        const name = prop.name?.text;
        if (name === undefined) return null;
        add(name);
        continue;
      }
      if (ts.isPropertyAssignment(prop)) {
        const name = prop.name;
        if (!ts.isComputedPropertyName(name) && name.text === "__proto__") {
          // B.3.1: this member sets the exports object's prototype; it is
          // not an export name. A later one replaces it, as Node's literal
          // evaluation does.
          proto = prop.initializer;
          continue;
        }
        // A numeric name canonicalizes ('1e3' is the property '1000'), so
        // its written spelling is not the export name.
        if (ts.isIdentifier(name) || ts.isStringLiteral(name)) add(name.text);
        else return null;
        continue;
      }
      const method = cjsTableMethodEntry(prop);
      if (method === null) return null; // spread, accessor, or computed key
      add(method.name.text);
    }
  }
  // The `__proto__` value the table statement stored (lower-modules.ts)
  // builds the exports object's prototype. A table whose statement did not
  // store one is not the statically known table this lowering can publish.
  if (proto !== null && !lowerer.cjsProtoGlobals.has(lowerer.pathOf(dep))) return null;
  return { owner: dep, names, proto };
}

/** The compiled getter behind an exports object: one lifted function per
 * module that answers an export's current value by name. An export whose
 * value has no checked-dynamic form throws its fence when it is read. */
function cjsExportsGetter(
  lowerer: Lowerer,
  dep: ts.SourceFile,
  moduleId: string,
  keys: readonly string[],
): string {
  const name = `%cjs.exports:${moduleId}`;
  if (lowerer.liftedFns.some((fn) => fn.name === name)) return name;
  const context = newFnCtx(false, null, null, DYN);
  const previousClass = lowerer.currentClass;
  lowerer.currentClass = null;
  lowerer.fnStack.push(context);
  try {
    const body: IrStmt[] = [];
    for (const key of keys) {
      const blame = lowerer.cjsModuleExportSymbol(dep, key)?.declarations[0] ?? dep;
      const loc = locOf(blame);
      const diagsBefore = lowerer.diags.length;
      let read: IrStmt[];
      try {
        const value = cjsExportValueByName(lowerer, dep, key, blame);
        if (value === null) {
          lowerer.unsupported(
            "SC1090",
            blame,
            `reading the export '${key}' through the module's exports object`,
          );
        }
        const dyn = lowerer.coerceToExpected(value, DYN);
        if (dyn.type.kind !== "dyn") {
          lowerer.unsupported(
            "SC1101",
            blame,
            `reading the export '${key}' ('${lowerer.fmt(dyn.type)}') through the module's exports object`,
          );
        }
        read = [{ kind: "return", value: dyn, loc }];
      } catch (err) {
        if (!(err instanceof PoisonError)) throw err;
        const fence = lowerer.deferToRuntimeFence(diagsBefore, blame, { kind: "statement" });
        if (!fence) throw err;
        read = [fence];
      }
      body.push({
        kind: "if",
        cond: {
          kind: "strEq",
          negated: false,
          left: varRef("key", STRING, loc),
          right: strLit(key, loc),
          type: { kind: "bool" },
          loc,
        },
        then: read,
        else_: null,
        loc,
      });
    }
    body.push({ kind: "return", value: dynUndefinedExpr(locOf(dep)), loc: locOf(dep) });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "key", name: "key", type: STRING }],
      returnType: DYN,
      locals: [{ id: "key", name: "key", type: STRING, mutable: false }, ...context.locals],
      body,
      loc: locOf(dep),
    });
  } finally {
    lowerer.fnStack.pop();
    lowerer.currentClass = previousClass;
  }
  return name;
}

/** The exports object of `dep` as a checked-dynamic value, or null when the
 * module's export names are not statically known (a computed name, or an
 * exports object replaced by a value that is not another program module's
 * exports) or the module is not in this program. */
export function lowerCjsExportsValue(
  lowerer: Lowerer,
  dep: ts.SourceFile,
  loc: SrcLoc,
): IrExpr | null {
  if (!lowerer.moduleOrder.includes(dep)) return null;
  const namespace = lowerer.cjsNamespaceOf(dep);
  // An export name assigned inside a function, or a replacement there,
  // leaves no static property set to build the object from.
  if (namespace.assignedLater === "all") return null;
  const table = cjsExportsTableNames(lowerer, dep);
  if (table === null) return null;
  // A module that re-exports another program module's exports as its whole
  // value exposes that module's object: one object per export table, the
  // same one a direct requirer of the dependency holds.
  const moduleId = `cjs:${lowerer.pathOf(table.owner)}`;
  const getter = cjsExportsGetter(lowerer, table.owner, moduleId, table.names);
  // A table literal's `__proto__` member sets the exports object's
  // prototype as Node builds the literal (B.3.1). The module's own table
  // statement evaluated it once at its source position and stored the value
  // (lower-stmts.ts); the runtime applies that same value when it builds the
  // module's one exports object, so every holder sees one prototype and a
  // mutation through it stays visible.
  const protoGlobal =
    table.proto === null ? undefined : lowerer.cjsProtoGlobals.get(lowerer.pathOf(table.owner));
  const proto: IrExpr = protoGlobal
    ? { kind: "varRef", localId: protoGlobal.id, type: DYN, loc }
    : dynUndefinedExpr(loc);
  return {
    kind: "libCall",
    fn: "module.cjsExports",
    args: [
      strLit(moduleId, loc),
      {
        kind: "arrayLit",
        elems: table.names.map((key) => strLit(key, loc)),
        type: arrayOf(STRING),
        loc,
      },
      {
        kind: "dynFrom",
        value: {
          kind: "closure",
          fnName: getter,
          captures: [],
          type: funcOf([STRING], DYN),
          loc,
        },
        type: DYN,
        loc,
      },
      proto,
    ],
    type: DYN,
    loc,
  };
}
