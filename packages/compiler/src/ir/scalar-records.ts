import {
  F64,
  isRefCounted,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrRecordShape,
  type IrStmt,
} from "./ir.js";
import {
  everyExpr,
  transformExpr,
  everyExprChild,
  everyStmtChild,
  everyStmtList,
  transformStmtList,
} from "./traverse.js";

const MAX_FIELDS = 4;
const MAX_CALLEE_NODES = 256;
const MAX_INLINE_NODES = 1024;

interface Producer {
  fn: IrFunction;
  shape: IrRecordShape;
  size: number;
}

/** Splitting an expression frame must not shorten a reference temporary's
 * lifetime across later arguments, fields, or the original call itself. */
function scalarTemporaries(value: IrExpr): boolean {
  return everyExpr(value, { expr: (expr) => !isRefCounted(expr.type), stmt: () => true });
}

function producer(fn: IrFunction, shapes: ReadonlyMap<string, IrRecordShape>): Producer | null {
  if (
    fn.async ||
    fn.generator ||
    fn.captures?.length ||
    fn.classCaptures?.length ||
    fn.returnType.kind !== "record"
  )
    return null;
  const shape = shapes.get(fn.returnType.shapeId);
  if (
    !shape ||
    shape.tuple ||
    shape.indexValue ||
    shape.fields.length === 0 ||
    shape.fields.length > MAX_FIELDS ||
    shape.fields.some((f) => f.type.kind !== "f64")
  )
    return null;
  // Scalar parameters/locals need no ownership cleanup across the inlined
  // return. Closures, suspension and finally completions remain out of scope.
  if (
    fn.locals.some((l) => l.boxed || l.tdz || (l.type.kind !== "f64" && l.type.kind !== "bool")) ||
    fn.params.some((p) => p.type.kind !== "f64" && p.type.kind !== "bool")
  )
    return null;
  let size = 0;
  let returns = 0;
  const eligible = everyStmtList(fn.body, {
    expr: (expr) => {
      if (++size > MAX_CALLEE_NODES) return false;
      switch (expr.kind) {
        case "closure":
        case "selfRef":
        case "awaitExpr":
        case "awaitUnionExpr":
        case "yieldExpr":
          return false;
        default:
          return true;
      }
    },
    stmt: (stmt) => {
      if (++size > MAX_CALLEE_NODES || stmt.kind === "tryCatch") return false;
      if (stmt.kind !== "return") return true;
      returns++;
      const value = stmt.value;
      return (
        value?.kind === "recordLit" &&
        value.type.kind === "record" &&
        value.type.shapeId === shape.id &&
        value.fields.length === shape.fields.length &&
        value.fields.every(
          (f) =>
            !f.overflow &&
            f.value.type.kind === "f64" &&
            scalarTemporaries(f.value) &&
            shape.fields.some((sf) => sf.name === f.name),
        )
      );
    },
  });
  return eligible && returns > 0 ? { fn, shape, size } : null;
}

/** A result may only be read through its declared scalar fields. Even an
 * apparently harmless alias, identity test, mutation or closure capture
 * keeps the original object. Count declarations too: no reinitialization. */
function fieldOnlyUses(fn: IrFunction, localId: string, shape: IrRecordShape): boolean {
  let declarations = 0;
  function expr(node: IrExpr): boolean {
    if (node.kind === "recordGet" && node.obj.kind === "varRef" && node.obj.localId === localId) {
      return (
        node.shapeId === shape.id &&
        node.type.kind === "f64" &&
        shape.fields.some((f) => f.name === node.field)
      );
    }
    switch (node.kind) {
      case "varRef":
      case "incDec":
      case "assignExpr":
        if (node.localId === localId) return false;
        break;
      case "closure":
      case "classRef":
        if (node.captures?.includes(localId)) return false;
        break;
    }
    return everyExprChild(node, expr, stmt);
  }
  function stmt(node: IrStmt): boolean {
    switch (node.kind) {
      case "varDecl":
        if (node.localId === localId && ++declarations !== 1) return false;
        break;
      case "assign":
      case "forOf":
      case "rethrow":
        if (node.localId === localId) return false;
        break;
    }
    return everyStmtChild(node, expr, stmt);
  }
  return fn.body.every(stmt) && declarations === 1;
}

/** Label ids participate in the same fresh-name namespace as local ids. */
function collectLabels(body: IrStmt[], used: Set<string>): void {
  everyStmtList(body, {
    expr: () => true,
    stmt: (node) => {
      switch (node.kind) {
        case "while":
        case "doWhile":
        case "for":
        case "forOf":
        case "switch":
        case "block":
          for (const label of node.labels ?? []) used.add(label);
          break;
      }
      return true;
    },
  });
}

interface Replacement {
  fields: Map<string, string>;
  body: IrStmt[];
}

/** Eliminate small fresh numeric result records at direct, field-only call
 * sites. This is a bounded shared backend pass, not a change to record ABI:
 * the original producer remains available to all other callers. Arguments
 * and literal fields retain source evaluation order. A labeled block models
 * return, including returns inside loops, without changing caller control
 * flow. Unknown uses and non-scalar producer locals keep the heap path. */
export function scalarizeNumericRecords(mod: IrModule): IrModule {
  const shapes = new Map((mod.records ?? []).map((s) => [s.id, s]));
  const producers = new Map<string, Producer>();
  for (const fn of mod.functions) {
    const p = producer(fn, shapes);
    if (p) producers.set(fn.name, p);
  }
  if (producers.size === 0) return mod;
  let changed = false;
  const functions = mod.functions.map((fn): IrFunction => {
    if (fn.async || fn.generator) return fn;
    const locals = new Map(fn.locals.map((l) => [l.id, l]));
    const used = new Set([...locals.keys(), ...(mod.globals ?? []).map((g) => g.id)]);
    collectLabels(fn.body, used);
    // A header accepts one statement, not an inlined block. Local ids are
    // unique within a function and fieldOnlyUses proves one declaration.
    const loopHeaders = new Set<string>();
    everyStmtList(fn.body, {
      expr: () => true,
      stmt: (node) => {
        if (node.kind === "for") {
          if (node.init?.kind === "varDecl") loopHeaders.add(node.init.localId);
          if (node.update?.kind === "varDecl") loopHeaders.add(node.update.localId);
        }
        return true;
      },
    });
    let next = 0;
    const fresh = (): string => {
      let id: string;
      do {
        id = `%scalar.${next++}`;
      } while (used.has(id));
      used.add(id);
      return id;
    };
    const added: IrLocal[] = [];
    const replacements = new Map<string, Replacement>();
    let budget = MAX_INLINE_NODES;
    everyStmtList(fn.body, {
      expr: () => true,
      stmt: (decl) => {
        if (decl.kind !== "varDecl" || loopHeaders.has(decl.localId)) return true;
        const local = locals.get(decl.localId);
        const call = decl.init;
        if (
          !local ||
          local.mutable ||
          local.boxed ||
          local.tdz ||
          local.type.kind !== "record" ||
          call?.kind !== "call"
        )
          return true;
        const p = producers.get(call.callee);
        if (
          !p ||
          p.fn.name === fn.name ||
          p.size > budget ||
          p.shape.id !== local.type.shapeId ||
          call.args.length !== p.fn.params.length ||
          !call.args.every(scalarTemporaries) ||
          !fieldOnlyUses(fn, local.id, p.shape)
        )
          return true;
        budget -= p.size;
        for (const l of p.fn.locals) used.add(l.id);
        collectLabels(p.fn.body, used);
        const fields = new Map(p.shape.fields.map((f) => [f.name, fresh()]));
        const renamed = new Map(p.fn.locals.map((l) => [l.id, fresh()]));
        const labels = new Map<string, string>();
        const exit = fresh();
        const label = (name: string): string => {
          if (!labels.has(name)) labels.set(name, fresh());
          return labels.get(name)!;
        };
        for (const f of p.shape.fields)
          added.push({
            id: fields.get(f.name)!,
            name: `${local.name}.${f.name}`,
            type: F64,
            mutable: true,
          });
        for (const l of p.fn.locals) added.push({ ...l!, id: renamed.get(l.id)! });
        const body = transformStmtList(p.fn.body, {
          expr: (expr) => {
            switch (expr.kind) {
              case "varRef":
                return { ...expr, localId: renamed.get(expr.localId) ?? expr.localId };
              case "incDec":
                return { ...expr, localId: renamed.get(expr.localId) ?? expr.localId };
              case "assignExpr":
                return { ...expr, localId: renamed.get(expr.localId) ?? expr.localId };
              default:
                return expr;
            }
          },
          stmt: (stmt): IrStmt => {
            switch (stmt.kind) {
              case "return": {
                const literal = stmt.value;
                if (literal?.kind !== "recordLit") return stmt; // producer proved this shape
                const assignments: IrStmt[] = literal.fields.map((f): IrStmt => ({
                  kind: "assign",
                  localId: fields.get(f.name)!,
                  value: f.value,
                  loc: stmt.loc,
                }));
                return {
                  kind: "block",
                  body: [...assignments, { kind: "break", label: exit, loc: stmt.loc }],
                  loc: stmt.loc,
                };
              }
              case "varDecl":
                return { ...stmt, localId: renamed.get(stmt.localId) ?? stmt.localId };
              case "assign":
                return { ...stmt, localId: renamed.get(stmt.localId) ?? stmt.localId };
              case "forOf":
                return stmt.labels
                  ? {
                      ...stmt,
                      localId: renamed.get(stmt.localId) ?? stmt.localId,
                      labels: stmt.labels.map(label),
                    }
                  : { ...stmt, localId: renamed.get(stmt.localId) ?? stmt.localId };
              case "break":
                return stmt.label && stmt.label !== exit
                  ? { ...stmt, label: label(stmt.label) }
                  : stmt;
              case "continue":
                return stmt.label ? { ...stmt, label: label(stmt.label) } : stmt;
              case "while":
                return stmt.labels ? { ...stmt, labels: stmt.labels.map(label) } : stmt;
              case "doWhile":
                return stmt.labels ? { ...stmt, labels: stmt.labels.map(label) } : stmt;
              case "for":
                return stmt.labels ? { ...stmt, labels: stmt.labels.map(label) } : stmt;
              case "switch":
                return stmt.labels ? { ...stmt, labels: stmt.labels.map(label) } : stmt;
              case "block":
                return stmt.labels ? { ...stmt, labels: stmt.labels.map(label) } : stmt;
              default:
                return stmt;
            }
          },
        });
        const parameters: IrStmt[] = p.fn.params.map((param, i): IrStmt => ({
          kind: "varDecl",
          localId: renamed.get(param.localId)!,
          init: call.args[i]!,
          loc: decl.loc,
        }));
        const declarations: IrStmt[] = [...fields.values()].map((id): IrStmt => ({
          kind: "varDecl",
          localId: id!,
          init: null,
          loc: decl.loc,
        }));
        replacements.set(local.id, {
          fields,
          body: [
            ...declarations,
            { kind: "block", labels: [exit], body: [...parameters, ...body], loc: decl.loc },
          ],
        });
        return true;
      },
    });
    if (replacements.size === 0) return fn;
    changed = true;
    const body = transformStmtList(fn.body, {
      stmt: (stmt) => {
        const replacement = stmt.kind === "varDecl" ? replacements.get(stmt.localId) : undefined;
        return replacement ? { kind: "block", body: replacement.body, loc: stmt.loc } : stmt;
      },
      expr: (expr) => {
        if (expr.kind === "recordGet" && expr.obj.kind === "varRef") {
          const id = replacements.get(expr.obj.localId)?.fields.get(expr.field);
          if (id) return { kind: "varRef", localId: id, type: F64, loc: expr.loc };
        }
        return expr;
      },
    });
    return {
      ...fn!,
      locals: [...fn.locals.filter((l) => !replacements.has(l.id)), ...added],
      body,
    };
  });
  return changed ? { ...mod, functions } : mod;
}

/** A producer whose whole body is `return <literal>`, with number, boolean
 * or string fields, inlined where its result is destructured. */
interface LiteralProducer {
  fn: IrFunction;
  shape: IrRecordShape;
  literal: IrExpr & { kind: "recordLit" };
  size: number;
  /** The parameters the literal writes (`a++`, `a = b`). */
  written: ReadonlySet<string>;
}

/** Whether `value` holds no counted temporary of its own: every counted
 * node in it only views a binding, so evaluating it in its own statement
 * shortens no lifetime. A message argument of a throw counts as nothing: it
 * lives until the throw, which ends the evaluation anyway. */
function viewsOnly(value: IrExpr): boolean {
  if (!isRefCounted(value.type)) return everyExprChild(value, viewsOnly, () => false);
  switch (value.kind) {
    case "varRef":
      return true;
    case "unionNarrow":
      return viewsOnly(value.value);
    case "ternary":
      return viewsOnly(value.cond) && viewsOnly(value.then) && viewsOnly(value.else_);
    case "libCall":
      return value.fn === "error.nodeThrow";
    default:
      return false;
  }
}

/** The node's own value may be counted (it moves into the binding that
 * takes it); everything under it must hold no temporary (viewsOnly), as
 * scalarTemporaries requires for the numeric pass. */
function ownedTemporaries(value: IrExpr): boolean {
  return everyExprChild(value, viewsOnly, () => false);
}

const LITERAL_FIELD_KINDS: ReadonlySet<string> = new Set(["f64", "bool", "string"]);

function literalProducer(
  fn: IrFunction,
  shapes: ReadonlyMap<string, IrRecordShape>,
): LiteralProducer | null {
  if (
    fn.async ||
    fn.generator ||
    fn.captures?.length ||
    fn.classCaptures?.length ||
    fn.returnType.kind !== "record" ||
    fn.body.length !== 1
  )
    return null;
  const shape = shapes.get(fn.returnType.shapeId);
  if (
    !shape ||
    shape.indexValue ||
    shape.fields.length === 0 ||
    shape.fields.length > MAX_FIELDS ||
    shape.fields.some((f) => !LITERAL_FIELD_KINDS.has(f.type.kind))
  )
    return null;
  // Every local is a parameter: the body declares nothing.
  const params = new Set(fn.params.map((p) => p.localId));
  if (fn.locals.some((l) => l.boxed || l.tdz || !params.has(l.id))) return null;
  const ret = fn.body[0]!;
  const literal = ret.kind === "return" ? ret.value : null;
  if (
    literal?.kind !== "recordLit" ||
    literal.type.kind !== "record" ||
    literal.type.shapeId !== shape.id ||
    literal.fields.length !== shape.fields.length ||
    !literal.fields.every(
      (f) =>
        !f.overflow &&
        shape.fields.some((sf) => sf.name === f.name && sf.type.kind === f.value.type.kind) &&
        ownedTemporaries(f.value),
    )
  )
    return null;
  let size = 0;
  const written = new Set<string>();
  const small = everyExpr(literal, {
    expr: (node) => {
      if (node.kind === "incDec" || node.kind === "assignExpr") written.add(node.localId);
      return (
        ++size <= MAX_CALLEE_NODES &&
        node.kind !== "closure" &&
        node.kind !== "selfRef" &&
        node.kind !== "awaitExpr" &&
        node.kind !== "awaitUnionExpr" &&
        node.kind !== "yieldExpr"
      );
    },
    stmt: () => false,
  });
  return small ? { fn, shape, literal, size, written } : null;
}

/** Rewrite every statement list under `body`, innermost first. */
function mapStatementLists(body: IrStmt[], f: (list: IrStmt[]) => IrStmt[]): IrStmt[] {
  const lists = (s: IrStmt): IrStmt => {
    switch (s.kind) {
      case "if":
        return {
          ...s,
          then: mapStatementLists(s.then, f),
          else_: s.else_ === null ? null : mapStatementLists(s.else_, f),
        };
      case "block":
      case "while":
      case "doWhile":
      case "for":
      case "forOf":
        return { ...s, body: mapStatementLists(s.body, f) };
      case "switch":
        return {
          ...s,
          cases: s.cases.map((c) => ({
            ...c,
            body: mapStatementLists(c.body, f),
          })),
        };
      case "tryCatch":
        return {
          ...s,
          tryBody: mapStatementLists(s.tryBody, f),
          catchBody: s.catchBody === null ? null : mapStatementLists(s.catchBody, f),
          finallyBody: s.finallyBody === null ? null : mapStatementLists(s.finallyBody, f),
        };
      default:
        return s;
    }
  };
  return f(body.map(lists));
}

/** How often each local is read, anywhere in `fn`. */
function localReads(fn: IrFunction): Map<string, number> {
  const reads = new Map<string, number>();
  const count = (id: string): void => {
    reads.set(id, (reads.get(id) ?? 0) + 1);
  };
  everyStmtList(fn.body, {
    expr: (node) => {
      switch (node.kind) {
        case "varRef":
        case "incDec":
        case "assignExpr":
          count(node.localId);
          break;
        case "closure":
        case "classRef":
          for (const id of node.captures ?? []) count(id);
          break;
      }
      return true;
    },
    stmt: (node) => {
      if (node.kind === "assign" || node.kind === "forOf" || node.kind === "rethrow")
        count(node.localId);
      return true;
    },
  });
  return reads;
}

/** Inline small literal producers where the result is only destructured.
 *
 * `const [head, tail] = split(text, at)`, where `split` is
 * `return [text.slice(0, at), text.slice(at)]`, lowers to a result binding
 * and one declaration per element read from it, right after the call. Each
 * such declaration now takes its field's value directly: the parameters are
 * declared from the arguments in order, then the fields in the literal's
 * order (unread fields go to fresh bindings), then the destructured
 * bindings, so evaluation order is unchanged and no record is built. A
 * slice element read only through its length then needs no copy at all
 * (findScalarStringSlices). The declarations stay in the caller's own
 * statement list, so every binding keeps its scope; parameters live to the
 * end of it, which only lengthens the arguments' lifetimes. Every other use
 * of the result binding keeps the call. */
export function scalarizeLiteralResults(mod: IrModule): IrModule {
  const shapes = new Map((mod.records ?? []).map((s) => [s.id, s]));
  const producers = new Map<string, LiteralProducer>();
  for (const fn of mod.functions) {
    const p = literalProducer(fn, shapes);
    if (p) producers.set(fn.name, p);
  }
  if (producers.size === 0) return mod;
  let changed = false;
  const globalIds = new Set((mod.globals ?? []).map((g) => g.id));
  const functions = mod.functions.map((fn): IrFunction => {
    if (fn.async || fn.generator) return fn;
    const locals = new Map(fn.locals.map((l) => [l.id, l]));
    // The names a fresh binding must avoid, collected when the first one is
    // made: most functions inline no producer.
    let used: Set<string> | null = null;
    let next = 0;
    const fresh = (): string => {
      if (used === null) {
        used = new Set(locals.keys());
        collectLabels(fn.body, used);
      }
      let id: string;
      do {
        id = `%literal.${next++}`;
      } while (used.has(id) || globalIds.has(id));
      used.add(id);
      return id;
    };
    let reads: Map<string, number> | null = null;
    const added: IrLocal[] = [];
    const removed = new Set<string>();
    let budget = MAX_INLINE_NODES;
    const rewrite = (list: IrStmt[]): IrStmt[] => {
      const out: IrStmt[] = [];
      for (let i = 0; i < list.length; i++) {
        const decl = list[i]!;
        const call = decl.kind === "varDecl" ? decl.init : null;
        const p = call?.kind === "call" ? producers.get(call.callee) : undefined;
        const local = decl.kind === "varDecl" ? locals.get(decl.localId) : undefined;
        if (
          decl.kind !== "varDecl" ||
          call?.kind !== "call" ||
          !p ||
          !local ||
          p.fn.name === fn.name ||
          p.size > budget ||
          local.mutable ||
          local.boxed ||
          local.tdz ||
          local.type.kind !== "record" ||
          local.type.shapeId !== p.shape.id ||
          call.args.length !== p.fn.params.length ||
          !call.args.every(ownedTemporaries)
        ) {
          out.push(decl);
          continue;
        }
        // The element declarations right after the call, one per field.
        const elements = new Map<string, IrStmt & { kind: "varDecl" }>();
        let j = i + 1;
        for (; j < list.length; j++) {
          const element = list[j]!;
          const get = element.kind === "varDecl" ? element.init : null;
          const target = element.kind === "varDecl" ? locals.get(element.localId) : undefined;
          if (
            element.kind !== "varDecl" ||
            get?.kind !== "recordGet" ||
            get.obj.kind !== "varRef" ||
            get.obj.localId !== local.id ||
            get.shapeId !== p.shape.id ||
            elements.has(get.field) ||
            !target ||
            target.boxed ||
            target.tdz ||
            target.type.kind !== get.type.kind
          )
            break;
          elements.set(get.field, element);
        }
        reads ??= localReads(fn);
        if (elements.size === 0 || reads.get(local.id) !== elements.size) {
          out.push(decl);
          continue;
        }
        budget -= p.size;
        changed = true;
        removed.add(local.id);
        const renamed = new Map(p.fn.params.map((param) => [param.localId, fresh()]));
        for (const l of p.fn.locals) {
          // Copied field by field: the native compiler does not spread a
          // record whose type has a union.
          const copy: IrLocal = {
            id: renamed.get(l.id)!,
            name: l.name,
            type: l.type,
            mutable: p.written.has(l.id),
          };
          if (l.source !== undefined) copy.source = l.source;
          added.push(copy);
        }
        p.fn.params.forEach((param, index) => {
          out.push({
            kind: "varDecl",
            localId: renamed.get(param.localId)!,
            init: call.args[index]!,
            loc: decl.loc,
          });
        });
        // Reads and writes of a parameter (`a++`, `a = b`) both name it.
        const rename = (value: IrExpr): IrExpr =>
          transformExpr(value, {
            expr: (node) =>
              (node.kind === "varRef" || node.kind === "incDec" || node.kind === "assignExpr") &&
              renamed.has(node.localId)
                ? { ...node, localId: renamed.get(node.localId)! }
                : node,
            stmt: (node) => node,
          });
        for (const field of p.literal.fields) {
          const element = elements.get(field.name);
          let id = element?.localId;
          if (id === undefined) {
            id = fresh();
            const type = p.shape.fields.find((f) => f.name === field.name)!.type;
            added.push({
              id,
              name: `${local.name}.${field.name}`,
              type,
              mutable: false,
            });
          }
          out.push({
            kind: "varDecl",
            localId: id,
            init: rename(field.value),
            loc: element?.loc ?? decl.loc,
          });
        }
        i = j - 1;
      }
      return out;
    };
    const body = mapStatementLists(fn.body, rewrite);
    if (!changed || removed.size === 0) return fn;
    return {
      ...fn,
      locals: [...fn.locals.filter((l) => !removed.has(l.id)), ...added],
      body,
    };
  });
  return changed ? { ...mod, functions } : mod;
}
