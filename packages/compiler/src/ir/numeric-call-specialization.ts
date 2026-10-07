import {
  BOOL,
  F64,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrUnionDef,
} from "./ir.js";
import { everyStmtList, mapExprChildren, mapStmtChildren, transformStmtList } from "./traverse.js";

const MAX_FUNCTION_NODES = 1024;
const MAX_SPECIALIZATIONS = 32;
interface NumericParameter {
  index: number;
  localId: string;
  unionId: string;
  tag: number;
}

function parameters(fn: IrFunction, unions: ReadonlyMap<string, IrUnionDef>): NumericParameter[] {
  if (fn.async || fn.generator || fn.captures !== undefined || fn.classCaptures?.length) return [];
  const result: NumericParameter[] = [];
  fn.params.forEach((param, index) => {
    if (param.type.kind !== "union") return;
    const arms = unions.get(param.type.unionId)?.arms;
    if (arms?.length !== 2 || !arms.some((arm) => arm.kind === "undefinedT")) return;
    const tag = arms.findIndex((arm) => arm.kind === "f64");
    if (tag >= 0) result.push({ index, localId: param.localId, unionId: param.type.unionId, tag });
  });
  if (!result.length) return result;
  const selected = new Map(result.map((param) => [param.localId, param]));
  if (fn.locals.some((local) => selected.has(local.id) && (local.boxed || local.tdz))) return [];
  let size = 0;
  function numericWrite(id: string, value: IrExpr | undefined): boolean {
    const param = selected.get(id);
    return (
      !param ||
      (value?.kind === "unionWrap" &&
        value.unionId === param.unionId &&
        value.tag === param.tag &&
        value.value.type.kind === "f64")
    );
  }
  const eligible = everyStmtList(fn.body, {
    stmt: (stmt) => {
      if (++size > MAX_FUNCTION_NODES) return false;
      if (stmt.kind === "assign") return numericWrite(stmt.localId, stmt.value);
      if (stmt.kind === "varDecl" || stmt.kind === "forOf") return !selected.has(stmt.localId);
      return true;
    },
    expr: (expr) => {
      if (++size > MAX_FUNCTION_NODES) return false;
      if (expr.kind === "assignExpr") return numericWrite(expr.localId, expr.value);
      if (expr.kind === "incDec") return !selected.has(expr.localId);
      if (expr.kind === "closure" || expr.kind === "classRef")
        return !expr.captures?.some((id) => selected.has(id));
      return true;
    },
  });
  return eligible ? result : [];
}

function specializeBody(fn: IrFunction, slots: NumericParameter[]): IrStmt[] {
  const selected = new Map(slots.map((param) => [param.localId, param]));
  return transformStmtList(fn.body, {
    stmt: (stmt) => {
      if (stmt.kind === "assign" && selected.has(stmt.localId) && stmt.value.kind === "unionWrap")
        return { ...stmt, value: stmt.value.value };
      return stmt;
    },
    expr: (expr) => {
      if (
        (expr.kind === "unionNarrow" || expr.kind === "unionIsTag") &&
        expr.value.kind === "varRef"
      ) {
        const param = selected.get(expr.value.localId);
        if (param && expr.unionId === param.unionId) {
          if (expr.kind === "unionIsTag")
            return {
              kind: "boolLit",
              value: (expr.tag === param.tag) !== expr.negated,
              type: BOOL,
              loc: expr.loc,
            };
          if (expr.tag === param.tag) return { ...expr.value, type: F64 };
        }
      }
      if (expr.kind === "varRef") {
        const param = selected.get(expr.localId);
        if (param && expr.type.kind === "union" && expr.type.unionId === param.unionId)
          return {
            kind: "unionWrap",
            unionId: param.unionId,
            tag: param.tag,
            value: { ...expr, type: F64 },
            type: expr.type,
            loc: expr.loc,
          };
      }
      if (expr.kind === "assignExpr") {
        const param = selected.get(expr.localId);
        if (param && expr.value.kind === "unionWrap")
          return {
            kind: "unionWrap",
            unionId: param.unionId,
            tag: param.tag,
            value: { ...expr, value: expr.value.value, type: F64 },
            type: expr.type,
            loc: expr.loc,
          };
      }
      return expr;
    },
  });
}

/** Direct calls that already carry known numbers need no optional-parameter
 * boxes. Keep the ordinary function and its ABI for holes, undefined,
 * closures, exports and virtual dispatch. One bounded native variant per
 * function preserves the body, argument order and return representation;
 * mixed or unknown incoming values retain the original call. The backend
 * supplies its symbol spelling to avoid collisions after name mangling. */
export function specializeNumericCalls(
  mod: IrModule,
  symbolName: (name: string) => string = (name) => name,
): IrModule {
  const unions = new Map(mod.unions?.map((union) => [union.id, union]));
  const candidates = new Map<string, { fn: IrFunction; slots: NumericParameter[] }>();
  for (const fn of mod.functions) {
    const slots = parameters(fn, unions);
    if (slots.length) candidates.set(fn.name, { fn, slots });
  }
  if (!candidates.size) return mod;
  const names = new Set(mod.functions.map((fn) => symbolName(fn.name)));
  const variants = new Map<string, IrFunction>();
  const pending: IrFunction[] = [];
  function candidateCall(expr: IrExpr) {
    if (expr.kind !== "call") return undefined;
    const candidate = candidates.get(expr.callee);
    if (!candidate || candidate.fn.name === mod.entry) return undefined;
    return candidate.slots.every((param) => {
      const arg = expr.args[param.index];
      return (
        arg?.kind === "unionWrap" &&
        arg.unionId === param.unionId &&
        arg.tag === param.tag &&
        arg.value.type.kind === "f64"
      );
    })
      ? candidate
      : undefined;
  }
  function rewriteExpr(expr: IrExpr): IrExpr {
    const node = mapExprChildren(expr, rewriteExpr, rewriteStmt);
    if (node.kind !== "call") return node;
    const candidate = candidateCall(node);
    if (!candidate) return node;
    const { fn, slots } = candidate;
    let variant = variants.get(fn.name);
    if (!variant) {
      if (variants.size >= MAX_SPECIALIZATIONS) return node;
      let name = `${fn.name}.nativeNumber`;
      while (names.has(symbolName(name))) name += "_";
      names.add(symbolName(name));
      const ids = new Set(slots.map((param) => param.localId));
      const { ownsPrototype: _ownsPrototype, ...implementation } = fn;
      variant = {
        ...implementation,
        name,
        params: fn.params.map((param) =>
          ids.has(param.localId) ? { ...param!, type: F64 } : param,
        ),
        locals: fn.locals.map((local) => (ids.has(local.id) ? { ...local!, type: F64 } : local)),
        body: specializeBody(fn, slots),
      };
      variants.set(fn.name, variant);
      pending.push(variant);
    }
    const indices = new Set(slots.map((param) => param.index));
    return {
      ...node,
      callee: variant.name,
      args: node.args.map((arg, index) =>
        indices.has(index) && arg.kind === "unionWrap" ? arg.value : arg,
      ),
    };
  }
  function rewriteStmt(stmt: IrStmt): IrStmt {
    return mapStmtChildren(stmt, rewriteExpr, rewriteStmt);
  }
  function rewriteFunction(fn: IrFunction): IrFunction {
    // Most bodies never call an eligible entry. Inspect without allocating
    // replacement nodes; preserve their original storage and identities.
    const unchanged = everyStmtList(fn.body, {
      stmt: () => true,
      expr: (expr) => candidateCall(expr) === undefined,
    });
    return unchanged ? fn : { ...fn, body: fn.body.map(rewriteStmt) };
  }
  const functions = mod.functions.map(rewriteFunction);
  for (let i = 0; i < pending.length; i++) {
    const fn = pending[i]!;
    functions.push(rewriteFunction(fn));
  }
  return variants.size ? { ...mod, functions } : mod;
}
