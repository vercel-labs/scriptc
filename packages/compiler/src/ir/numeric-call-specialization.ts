import {
  BOOL,
  F64,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrType,
  type IrUnionDef,
} from "./ir.js";
import { exprFunctionReference, moduleFunctionReferences } from "./function-references.js";
import { everyStmtList, mapExprChildren, mapStmtChildren, transformStmtList } from "./traverse.js";

const MAX_FUNCTION_NODES = 1024;
/** The variants' bodies together: at least this many nodes, or a tenth of
 * the module's. */
const MIN_SPECIALIZATION_BUDGET = 32 * MAX_FUNCTION_NODES;

interface NumericParameter {
  index: number;
  localId: string;
  unionId: string;
  /** The tag of the number or boolean arm, and that arm's type. */
  tag: number;
  arm: IrType;
  undefinedTag: number;
  /** The constant of `param = <constant>`, when the parameter's only reads
   * are that default's: a call that passes undefined (or omits the
   * argument) then calls the variant with the constant instead. */
  fallback: IrExpr | null;
}

function parameters(fn: IrFunction, unions: ReadonlyMap<string, IrUnionDef>): NumericParameter[] {
  if (fn.async || fn.generator || fn.captures !== undefined || fn.classCaptures?.length) return [];
  const result: NumericParameter[] = [];
  fn.params.forEach((param, index) => {
    if (param.type.kind !== "union") return;
    const arms = unions.get(param.type.unionId)?.arms;
    if (arms?.length !== 2) return;
    const undefinedTag = arms.findIndex((arm) => arm.kind === "undefinedT");
    const tag = arms.findIndex((arm) => arm.kind === "f64" || arm.kind === "bool");
    if (undefinedTag < 0 || tag < 0) return;
    result.push({
      index,
      localId: param.localId,
      unionId: param.type.unionId,
      tag,
      arm: arms[tag]!.kind === "f64" ? F64 : BOOL,
      undefinedTag,
      fallback: null,
    });
  });
  if (!result.length) return result;
  const selected = new Map(result.map((param) => [param.localId, param]));
  if (fn.locals.some((local) => selected.has(local.id) && (local.boxed || local.tdz))) return [];
  let size = 0;
  function armWrite(id: string, value: IrExpr | undefined): boolean {
    const param = selected.get(id);
    return (
      !param ||
      (value?.kind === "unionWrap" &&
        value.unionId === param.unionId &&
        value.tag === param.tag &&
        value.value.type.kind === param.arm.kind)
    );
  }
  // Reads of each parameter, and the reads inside a default's declaration.
  const reads = new Map<string, number>();
  const eligible = everyStmtList(fn.body, {
    stmt: (stmt) => {
      if (++size > MAX_FUNCTION_NODES) return false;
      if (stmt.kind === "assign") return armWrite(stmt.localId, stmt.value);
      if (stmt.kind === "varDecl" || stmt.kind === "forOf") return !selected.has(stmt.localId);
      return true;
    },
    expr: (expr) => {
      if (++size > MAX_FUNCTION_NODES) return false;
      if (expr.kind === "varRef" && selected.has(expr.localId))
        reads.set(expr.localId, (reads.get(expr.localId) ?? 0) + 1);
      if (expr.kind === "assignExpr") return armWrite(expr.localId, expr.value);
      if (expr.kind === "incDec") return !selected.has(expr.localId);
      if (expr.kind === "closure" || expr.kind === "classRef")
        return !expr.captures?.some((id) => selected.has(id));
      return true;
    },
  });
  if (!eligible) return [];
  // A default the lowering writes as the body's leading declarations:
  // `x = isUndefined(param) ? <constant> : narrow(param)`. When those are the
  // parameter's only two reads, passing the constant is the same as passing
  // undefined.
  for (const stmt of fn.body) {
    if (stmt.kind !== "varDecl") break;
    const init = stmt.init;
    if (init?.kind !== "ternary") break;
    const { cond, then, else_ } = init;
    if (cond.kind !== "unionIsTag" || cond.negated || cond.value.kind !== "varRef") break;
    const param = selected.get(cond.value.localId);
    if (
      !param ||
      cond.unionId !== param.unionId ||
      cond.tag !== param.undefinedTag ||
      else_.kind !== "unionNarrow" ||
      else_.tag !== param.tag ||
      else_.value.kind !== "varRef" ||
      else_.value.localId !== param.localId ||
      reads.get(param.localId) !== 2 ||
      !constantOf(then, param.arm)
    )
      break;
    param.fallback = then;
  }
  return result;
}

function constantOf(expr: IrExpr, arm: IrType): boolean {
  return arm.kind === "f64" ? expr.kind === "numLit" : expr.kind === "boolLit";
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
          if (expr.tag === param.tag) return { ...expr.value, type: param.arm };
        }
      }
      if (expr.kind === "varRef") {
        const param = selected.get(expr.localId);
        if (param && expr.type.kind === "union" && expr.type.unionId === param.unionId)
          return {
            kind: "unionWrap",
            unionId: param.unionId,
            tag: param.tag,
            value: { ...expr, type: param.arm },
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
            value: { ...expr, value: expr.value.value, type: param.arm },
            type: expr.type,
            loc: expr.loc,
          };
      }
      return expr;
    },
  });
}

/** An argument the variant takes in place of a parameter's box: the
 * wrapped number or boolean, the default's constant for an undefined, or a
 * conditional choosing between two such arguments. */
function nativeArgument(arg: IrExpr | undefined, param: NumericParameter): IrExpr | null {
  if (arg?.kind === "ternary") {
    const then = nativeArgument(arg.then, param);
    const else_ = then && nativeArgument(arg.else_, param);
    return else_ ? { ...arg, then: then!, else_, type: param.arm } : null;
  }
  if (arg?.kind !== "unionWrap" || arg.unionId !== param.unionId) return null;
  if (arg.tag === param.tag && arg.value.type.kind === param.arm.kind) return arg.value;
  const fallback = param.fallback;
  if (arg.tag === param.undefinedTag && arg.value.kind === "unitLit" && fallback !== null)
    return { ...fallback, loc: arg.loc };
  return null;
}

function countNodes(body: IrStmt[]): number {
  let size = 0;
  everyStmtList(body, {
    stmt: () => {
      size++;
      return true;
    },
    expr: () => {
      size++;
      return true;
    },
  });
  return size;
}

/** Direct calls that already carry known numbers or booleans, or that pass
 * undefined to a parameter with a constant default, need no
 * optional-parameter boxes. Keep the ordinary function and its ABI for
 * other values, closures, exports and virtual dispatch. One native variant
 * per function preserves the body, argument order and return
 * representation; mixed or unknown incoming values retain the original
 * call. An ordinary function no reference reaches after the rewrite is
 * dropped. The variants share a node budget. The backend supplies its
 * symbol spelling to avoid collisions after name mangling. */
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
  let moduleNodes = 0;
  for (const fn of mod.functions) moduleNodes += countNodes(fn.body);
  let budget = Math.max(MIN_SPECIALIZATION_BUDGET, moduleNodes / 10);
  const names = new Set(mod.functions.map((fn) => symbolName(fn.name)));
  const variants = new Map<string, IrFunction>();
  const pending: IrFunction[] = [];
  function candidateCall(expr: IrExpr) {
    if (expr.kind !== "call") return undefined;
    const candidate = candidates.get(expr.callee);
    if (!candidate || candidate.fn.name === mod.entry) return undefined;
    return candidate.slots.every((param) => nativeArgument(expr.args[param.index], param) !== null)
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
      const body = specializeBody(fn, slots);
      const size = countNodes(body);
      if (size > budget) return node;
      budget -= size;
      let name = `${fn.name}.nativeNumber`;
      while (names.has(symbolName(name))) name += "_";
      names.add(symbolName(name));
      const types = new Map(slots.map((param) => [param.localId, param.arm]));
      const { ownsPrototype: _ownsPrototype, ...implementation } = fn;
      variant = {
        ...implementation,
        name,
        params: fn.params.map((param) => {
          const type = types.get(param.localId);
          return type ? { ...param!, type } : param;
        }),
        locals: fn.locals.map((local) => {
          const type = types.get(local.id);
          return type ? { ...local!, type } : local;
        }),
        body,
      };
      variants.set(fn.name, variant);
      pending.push(variant);
    }
    const byIndex = new Map(slots.map((param) => [param.index, param]));
    return {
      ...node,
      callee: variant.name,
      args: node.args.map((arg, index) => {
        const param = byIndex.get(index);
        return param ? nativeArgument(arg, param)! : arg;
      }),
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
  if (!variants.size) return mod;
  const unreferenced = unreferencedOriginals(mod, functions, variants);
  return {
    ...mod,
    functions: unreferenced.size ? functions.filter((fn) => !unreferenced.has(fn.name)) : functions,
  };
}

/** The ordinary functions of `variants` that nothing reaches any more: no
 * call or function reference from another function, no module metadata
 * names them, and they are not class members (which dispatch reaches by
 * their `%<class>.<member>` names). A function's prototype is observable
 * only through the function as a value, which is a reference. */
function unreferencedOriginals(
  mod: IrModule,
  functions: readonly IrFunction[],
  variants: ReadonlyMap<string, IrFunction>,
): Set<string> {
  const result = new Set<string>();
  const members = (mod.classes ?? []).map((cls) => `%${cls.name}.`);
  for (const name of variants.keys())
    if (!members.some((prefix) => name.startsWith(prefix))) result.add(name);
  for (const name of moduleFunctionReferences(mod)) result.delete(name);
  if (!result.size) return result;
  for (const fn of functions)
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (expr) => {
        const name =
          expr.kind === "call"
            ? expr.callee
            : expr.kind === "new"
              ? `%${expr.className}.constructor`
              : exprFunctionReference(expr);
        if (name !== undefined && name !== fn.name) result.delete(name);
        return true;
      },
    });
  return result;
}
