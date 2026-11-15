import type { IrExpr, IrFunction, IrModule, IrStmt } from "./ir.js";
import { numLit } from "./build.js";
import { everyStmtList, mapExprChildren, mapStmtChildren, transformStmtList } from "./traverse.js";
import { type IrNodeIndex } from "./node-index.js";

/** Largest body (IR nodes) a clone is made from. */
const MAX_FUNCTION_NODES = 800;
/** Clones of one function: one per array parameter and length. */
const MAX_CLONES_PER_FUNCTION = 2;
/** Module-wide cloned nodes: at least this many, or this share of the module. */
const MIN_CLONED_NODES = 4000;
const CLONED_NODE_FRACTION = 0.05;
/** Rounds of copying a literal through a chain of constant locals. */
const FOLD_ROUNDS = 4;

/** Array methods that read the array and nothing else: the receiver is not
 * written, resized or stored, and an element argument is a separate value. */
const READING_METHODS: ReadonlySet<string> = new Set([
  "length",
  "getNumber",
  "indexEq",
  "indexOf",
  "includes",
  "nextPresent",
]);

/** Thrown when a use does not fit the read-only shape a proof needs. */
const REJECT = Symbol("not a constant length binding");

function reject(): never {
  throw REJECT;
}

function countNodes(fn: IrFunction, index?: IrNodeIndex): number {
  const recorded = index?.nodeCount(fn);
  if (recorded !== undefined) return recorded;
  let count = 0;
  everyStmtList(fn.body, {
    stmt: () => (++count, true),
    expr: () => (++count, true),
  });
  return count;
}

/** The calls in `fn` that sit inside a loop. A call that repeats saves the
 * callee's length reads on every pass; a call that runs once per program run
 * saves a load and a compare and pays for a second copy of the callee. */
function callsInLoops(fn: IrFunction): Set<IrExpr> {
  const found = new Set<IrExpr>();
  const visitExpr = (node: IrExpr, loop: boolean): void => {
    if (loop && node.kind === "call") found.add(node);
    mapExprChildren(
      node,
      (child) => {
        visitExpr(child, loop);
        return child;
      },
      (statement) => {
        visitStmt(statement, loop);
        return statement;
      },
    );
  };
  const visitStmt = (statement: IrStmt, loop: boolean): void => {
    const inner =
      loop ||
      statement.kind === "while" ||
      statement.kind === "doWhile" ||
      statement.kind === "for" ||
      statement.kind === "forOf";
    mapStmtChildren(
      statement,
      (child) => {
        visitExpr(child, inner);
        return child;
      },
      (child) => {
        visitStmt(child, inner);
        return child;
      },
    );
  };
  for (const statement of fn.body) visitStmt(statement, false);
  return found;
}

/** Calls `visit` on `node` and every expression below it. */
function walkExpr(node: IrExpr, visit: (node: IrExpr) => void): void {
  visit(node);
  mapExprChildren(
    node,
    (child) => {
      walkExpr(child, visit);
      return child;
    },
    (statement) => {
      walkStmt(statement, visit);
      return statement;
    },
  );
}

function walkStmt(node: IrStmt, visit: (node: IrExpr) => void): void {
  mapStmtChildren(
    node,
    (child) => {
      walkExpr(child, visit);
      return child;
    },
    (child) => {
      walkStmt(child, visit);
      return child;
    },
  );
}

/** A place that writes a binding: the statement or expression that does it,
 * and the value it stores when the write is a plain definition. */
interface Write {
  node: IrStmt | IrExpr;
  value: IrExpr | null;
}

/** Every write to every binding the bodies hold, by binding local id. */
function collectWrites(bodies: readonly IrStmt[][]): Map<string, Write[]> {
  const writes = new Map<string, Write[]>();
  const note = (id: string, node: IrStmt | IrExpr, value: IrExpr | null): void => {
    const list = writes.get(id);
    if (list === undefined) writes.set(id, [{ node, value }]);
    else list.push({ node, value });
  };
  const scanExpr = (node: IrExpr): void => {
    if (node.kind === "assignExpr" || node.kind === "incDec") note(node.localId, node, null);
    mapExprChildren(
      node,
      (child) => {
        scanExpr(child);
        return child;
      },
      (child) => {
        scan(child);
        return child;
      },
    );
  };
  const scan = (statement: IrStmt): void => {
    if (statement.kind === "varDecl") note(statement.localId, statement, statement.init);
    else if (statement.kind === "assign") note(statement.localId, statement, statement.value);
    else if (statement.kind === "forOf") note(statement.localId, statement, null);
    else if (statement.kind === "tryCatch" && statement.catchLocalId !== null)
      note(statement.catchLocalId, statement, null);
    mapStmtChildren(
      statement,
      (child) => {
        scanExpr(child);
        return child;
      },
      (child) => {
        scan(child);
        return child;
      },
    );
  };
  for (const body of bodies) for (const statement of body) scan(statement);
  return writes;
}

/** The functions that name each of `ids`, in module order: a read, a write, a
 * loop or catch binding, or a closure capture of that id anywhere in the body.
 * A function that names a binding nowhere holds no use of it and no write to it. */
function functionsNaming(
  functions: readonly IrFunction[],
  ids: ReadonlySet<string>,
): Map<string, IrFunction[]> {
  const naming = new Map<string, IrFunction[]>();
  for (const fn of functions) {
    const note = (id: string): void => {
      if (!ids.has(id)) return;
      const list = naming.get(id);
      if (list === undefined) naming.set(id, [fn]);
      else if (list[list.length - 1] !== fn) list.push(fn);
    };
    const scanExpr = (node: IrExpr): void => {
      if (node.kind === "varRef" || node.kind === "assignExpr" || node.kind === "incDec")
        note(node.localId);
      else if (node.kind === "closure") for (const capture of node.captures) note(capture);
      mapExprChildren(
        node,
        (child) => {
          scanExpr(child);
          return child;
        },
        (child) => {
          scan(child);
          return child;
        },
      );
    };
    const scan = (statement: IrStmt): void => {
      if (statement.kind === "varDecl" || statement.kind === "assign" || statement.kind === "forOf")
        note(statement.localId);
      else if (statement.kind === "tryCatch" && statement.catchLocalId !== null)
        note(statement.catchLocalId);
      mapStmtChildren(
        statement,
        (child) => {
          scanExpr(child);
          return child;
        },
        (child) => {
          scan(child);
          return child;
        },
      );
    };
    for (const statement of fn.body) scan(statement);
  }
  return naming;
}

/** The locals of `fn` that hold the array `id` holds: the binding itself and
 * every local whose every write copies one of them. A copy is how a `for…of`
 * iterable or a cast reaches the array. A local a closure captures is left
 * out: the closure can reach the binding from its own function. */
function arrayHolders(
  fn: IrFunction,
  id: string,
): { holders: Set<string>; definitions: Set<IrStmt | IrExpr> } {
  const captured = new Set<string>();
  for (const statement of fn.body)
    walkStmt(statement, (node) => {
      if (node.kind === "closure") for (const capture of node.captures) captured.add(capture);
    });
  const writes = collectWrites([fn.body]);
  const holders = new Set<string>([id]);
  const definitions = new Set<IrStmt | IrExpr>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [candidate, list] of writes) {
      if (holders.has(candidate) || captured.has(candidate)) continue;
      const local = fn.locals.find((entry) => entry.id === candidate);
      if (local === undefined || local.boxed || local.mutable) continue;
      if (!list.length) continue;
      if (
        !list.every(
          (write) =>
            write.value !== null &&
            write.value.kind === "varRef" &&
            holders.has(write.value.localId),
        )
      )
        continue;
      holders.add(candidate);
      for (const write of list) definitions.add(write.node);
      changed = true;
    }
  }
  return { holders, definitions };
}

/** Whether every use of the array `holders` name is a read the proof keeps
 * exact: an element read or presence test at an index, an element-count read
 * or a search of a read-only method, a `for…of` iterable, or an argument that
 * the callee's matching parameter is itself proven read-only for. Writes,
 * stores into other values, returns, comparisons, spreads, enumerations and
 * captures are not. `allow` names the statements that define the binding and
 * its copies. */
function usesReadOnly(
  body: IrStmt[],
  holders: ReadonlySet<string>,
  allow: ReadonlySet<IrStmt | IrExpr>,
  callAllowed: (callee: string, argIndex: number) => boolean,
): boolean {
  /** A receiver position: a name the binding reaches, or an expression that
   * holds no such name. */
  const receiver = (node: IrExpr): void => {
    if (node.kind === "varRef") return;
    expr(node);
  };
  const expr = (node: IrExpr): void => {
    switch (node.kind) {
      case "varRef":
        if (holders.has(node.localId)) reject();
        return;
      case "arrayGet":
      case "arrayHas":
      case "arrayState":
        receiver(node.arr);
        expr(node.index);
        return;
      case "arrIntrinsic":
        if (READING_METHODS.has(node.method)) {
          receiver(node.receiver);
          for (const arg of node.args) expr(arg);
        } else {
          expr(node.receiver);
          for (const arg of node.args) expr(arg);
        }
        return;
      case "call":
        for (let index = 0; index < node.args.length; index++) {
          const arg = node.args[index]!;
          if (arg.kind === "varRef" && holders.has(arg.localId)) {
            if (!callAllowed(node.callee, index)) reject();
          } else expr(arg);
        }
        return;
      case "closure":
        // A nested function's body is a function of its own, which the
        // module-wide scan covers; a capture reaches the binding from there.
        if (node.captures.some((capture) => holders.has(capture))) reject();
        return;
      default:
        mapExprChildren(
          node,
          (child) => {
            expr(child);
            return child;
          },
          (child) => {
            stmt(child);
            return child;
          },
        );
        return;
    }
  };
  const stmt = (statement: IrStmt): void => {
    if (allow.has(statement)) return;
    switch (statement.kind) {
      case "varDecl":
        if (holders.has(statement.localId)) reject();
        if (statement.init !== null) expr(statement.init);
        return;
      case "assign":
        if (holders.has(statement.localId)) reject();
        expr(statement.value);
        return;
      case "forOf":
        receiver(statement.iterable);
        for (const inner of statement.body) stmt(inner);
        return;
      case "tryCatch":
        if (statement.catchLocalId !== null && holders.has(statement.catchLocalId)) reject();
        break;
      default:
        break;
    }
    mapStmtChildren(
      statement,
      (child) => {
        expr(child);
        return child;
      },
      (child) => {
        stmt(child);
        return child;
      },
    );
  };
  try {
    for (const statement of body) stmt(statement);
    return true;
  } catch (error) {
    if (error === REJECT) return false;
    throw error;
  }
}

/** The body of `origin` with every element-count read of parameter `id`
 * replaced by `length`, or null when the body reads none. */
function foldLengthReads(body: IrStmt[], id: string, length: number): IrStmt[] | null {
  let folded = 0;
  const next = transformStmtList(body, {
    expr: (node) => {
      if (
        node.kind === "arrIntrinsic" &&
        node.method === "length" &&
        node.receiver.kind === "varRef" &&
        node.receiver.localId === id
      ) {
        folded++;
        return numLit(length, node.loc);
      }
      return node;
    },
    stmt: (statement) => statement,
  });
  return folded === 0 ? null : next;
}

/** `body` with every constant local that holds a literal replaced by the
 * literal, repeated so a copy of a constant local folds too. A local folds
 * when it is never written but by one reading of a literal and no closure
 * captures it. */
function foldConstantLocals(fn: IrFunction, body: IrStmt[]): IrStmt[] {
  let current = body;
  for (let round = 0; round < FOLD_ROUNDS; round++) {
    const writes = collectWrites([current]);
    const literals = new Map<string, Extract<IrExpr, { kind: "numLit" }>>();
    for (const local of fn.locals) {
      if (local.mutable || local.boxed || local.type.kind !== "f64") continue;
      const list = writes.get(local.id);
      if (list?.length !== 1) continue;
      const write = list[0]!;
      if (write.node.kind !== "varDecl" || write.value?.kind !== "numLit") continue;
      literals.set(local.id, write.value);
    }
    if (!literals.size) return current;
    current = transformStmtList(current, {
      expr: (node) => {
        if (node.kind !== "varRef") return node;
        const literal = literals.get(node.localId);
        return literal === undefined ? node : { ...literal, loc: node.loc };
      },
      stmt: (statement) => statement,
    });
  }
  return current;
}

/** A clone of `origin` in which array parameter `paramIndex` holds an array
 * of exactly `length` present elements: every element-count read of the
 * parameter is the length itself, and constant locals that copy one fold to
 * it. Null when the body reads no element count of the parameter. */
function buildClone(origin: IrFunction, paramIndex: number, length: number): IrFunction | null {
  const param = origin.params[paramIndex]!;
  const folded = foldLengthReads(origin.body, param.localId, length);
  if (folded === null) return null;
  // The clone is reached by direct calls only, so it never surfaces as a
  // function value and owns no prototype of its own.
  const { ownsPrototype: _ownsPrototype, ...implementation } = origin;
  return {
    ...implementation,
    name: "",
    params: origin.params.map((candidate, index) =>
      index === paramIndex ? { ...candidate, constLength: length } : candidate,
    ),
    body: foldConstantLocals(origin, folded),
  };
}

/** Direct calls whose array argument is an array of one statically known
 * length call a clone of the callee in which that parameter carries the
 * length: an element-count read of the parameter is the length itself, any
 * element index proven in range names a present slot, and constant locals that
 * copy the length fold to it.
 *
 * A callee qualifies when an array parameter, and every local that holds the
 * same array, is used only through element reads, presence tests,
 * element-count reads and searches, `for…of` iteration and calls to callees
 * whose matching parameter is proven the same way — never resized, stored,
 * returned, compared, captured or spread — and the callee is an ordinary
 * function of at most MAX_FUNCTION_NODES nodes with no captures. An argument
 * qualifies when it is an array literal, a read-only local with one definition
 * from one, or an immutable global with one such definition that no other code
 * writes and no closure captures. The length and the hole-free prefix then
 * never change between the call and any use inside it, so the clone needs no
 * runtime test. Only calls inside a loop specialize: the fold pays on every
 * pass of the callee, not once at a call that runs a single time.
 *
 * Code growth is bounded: at most MAX_CLONES_PER_FUNCTION clones per function
 * and MIN_CLONED_NODES (or CLONED_NODE_FRACTION of the module) of cloned
 * nodes module-wide. `symbolName` spells names after mangling, and `index`,
 * an index of `mod`, gives node counts without walking bodies. */
export function specializeConstantArrayLengths(
  mod: IrModule,
  symbolName: (name: string) => string = (name) => name,
  index?: IrNodeIndex,
): IrModule {
  if (mod.lib) return mod;
  const functions = new Map(mod.functions.map((fn) => [fn.name, fn]));
  const globals = new Map((mod.globals ?? []).map((global) => [global.id, global]));
  const names = new Set(mod.functions.map((fn) => symbolName(fn.name)));
  let moduleNodes = 0;
  for (const fn of mod.functions) moduleNodes += countNodes(fn, index);
  let budget = Math.max(MIN_CLONED_NODES, moduleNodes * CLONED_NODE_FRACTION);
  const cloneCounts = new Map<string, number>();
  const clones = new Map<string, IrFunction | null>();
  const pending: IrFunction[] = [];
  const readOnlyParams = new Map<string, boolean>();
  const proving = new Set<string>();
  const bindingLengths = new Map<string, number | null>();

  /** Whether `target` never writes parameter `paramIndex`, never lets it
   * reach code that does, and never names it in a position that observes it. */
  function paramReadOnly(target: IrFunction, paramIndex: number): boolean {
    const key = `${target.name}\0${paramIndex}`;
    const known = readOnlyParams.get(key);
    if (known !== undefined) return known;
    const param = target.params[paramIndex];
    if (param === undefined || param.type.kind !== "array") return false;
    if (proving.has(key)) return false;
    proving.add(key);
    let result = false;
    try {
      const { holders, definitions } = arrayHolders(target, param.localId);
      result =
        (collectWrites([target.body]).get(param.localId) ?? []).length === 0 &&
        usesReadOnly(target.body, holders, definitions, callAllowed);
    } finally {
      proving.delete(key);
    }
    readOnlyParams.set(key, result);
    return result;
  }

  /** Whether passing a holder of `id` at argument `argIndex` of `callee`
   * keeps the array read-only. */
  function callAllowed(callee: string, argIndex: number): boolean {
    const target = functions.get(callee);
    if (!target) return false;
    return paramReadOnly(target, argIndex);
  }

  // A global's proof reads the whole module. The module's writes and the
  // functions that name each global are the same for every global, so they
  // are read once: a walk of the module per global was 20 s of the
  // compiler's own build.
  let moduleWrites: Map<string, Write[]> | null = null;
  let globalNamers: Map<string, IrFunction[]> | null = null;

  /** The length of the array `id` holds at every use, or null. `caller` is
   * the function that declares a local; a global has none. */
  function bindingLength(key: string, caller: IrFunction | null, id: string): number | null {
    const known = bindingLengths.get(key);
    if (known !== undefined) return known;
    bindingLengths.set(key, null);
    let result: number | null = null;
    let writes: Write[];
    let scope: readonly IrFunction[];
    if (caller !== null) {
      writes = collectWrites([caller.body]).get(id) ?? [];
      scope = [caller];
    } else {
      moduleWrites ??= collectWrites(mod.functions.map((fn) => fn.body));
      globalNamers ??= functionsNaming(mod.functions, new Set(globals.keys()));
      writes = moduleWrites.get(id) ?? [];
      // A function that does not name the global passes the check below
      // without asking anything, so only the ones that name it are asked.
      scope = globalNamers.get(id) ?? [];
    }
    if (writes.length === 1) {
      const write = writes[0]!;
      const value = write.value;
      const defines = write.node.kind === "varDecl" || write.node.kind === "assign";
      if (
        defines &&
        value !== null &&
        value.kind === "arrayLit" &&
        value.spreads === undefined &&
        value.elems.length > 0 &&
        scope.every((fn) => {
          const { holders, definitions } = arrayHolders(fn, id);
          return usesReadOnly(fn.body, holders, new Set([...definitions, write.node]), callAllowed);
        })
      )
        result = value.elems.length;
    }
    bindingLengths.set(key, result);
    return result;
  }

  /** The known length of the array `arg` holds, or null. */
  function argumentLength(arg: IrExpr, caller: IrFunction): number | null {
    if (arg.kind === "arrayLit") {
      if (arg.spreads !== undefined || arg.elems.length === 0) return null;
      return arg.elems.length;
    }
    if (arg.kind !== "varRef") return null;
    const id = arg.localId;
    const param = caller.params.find((candidate) => candidate.localId === id);
    if (param?.constLength !== undefined) return param.constLength;
    const local = caller.locals.find((candidate) => candidate.id === id);
    if (local !== undefined) {
      if (local.mutable || local.boxed) return null;
      return bindingLength(`local\0${caller.name}\0${id}`, caller, id);
    }
    const global = globals.get(id);
    if (global === undefined) return null;
    if (global.mutable || global.tdz === true || global.initFlag !== undefined) return null;
    return bindingLength(`global\0${id}`, null, id);
  }

  /** Whether the body reads the element count of parameter `id`, the read a
   * clone folds. */
  function readsLength(fn: IrFunction, id: string): boolean {
    let found = false;
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (node) => {
        if (
          node.kind === "arrIntrinsic" &&
          node.method === "length" &&
          node.receiver.kind === "varRef" &&
          node.receiver.localId === id
        )
          found = true;
        return true;
      },
    });
    return found;
  }

  function cloneFor(target: IrFunction, paramIndex: number, length: number): IrFunction | null {
    const key = `${target.name}\0${paramIndex}\0${length}`;
    const known = clones.get(key);
    if (known !== undefined) return known;
    let clone: IrFunction | null = null;
    const count = cloneCounts.get(target.name) ?? 0;
    if (
      count < MAX_CLONES_PER_FUNCTION &&
      target !== functions.get(mod.entry) &&
      !target.async &&
      target.generator === undefined &&
      target.captures === undefined &&
      !target.classCaptures?.length &&
      !target.fastRead &&
      !target.speculativeDispatch
    ) {
      const candidate = buildClone(target, paramIndex, length);
      if (candidate !== null) {
        const size = countNodes(candidate, index);
        if (size <= MAX_FUNCTION_NODES && size <= budget) {
          budget -= size;
          let name = `${target.name}.constLen`;
          while (names.has(symbolName(name))) name += "_";
          names.add(symbolName(name));
          clone = { ...candidate, name };
          cloneCounts.set(target.name, count + 1);
          functions.set(name, clone);
          pending.push(clone);
        }
      }
    }
    clones.set(key, clone);
    return clone;
  }

  /** The call with each qualifying array argument passing a clone of its
   * callee, or the call unchanged. */
  function specializeCall(call: Extract<IrExpr, { kind: "call" }>, caller: IrFunction) {
    const target = functions.get(call.callee);
    if (!target) return call;
    for (let paramIndex = 0; paramIndex < target.params.length; paramIndex++) {
      const param = target.params[paramIndex]!;
      if (param.type.kind !== "array" || param.owned || param.constLength !== undefined) continue;
      const arg = call.args[paramIndex];
      if (arg === undefined) continue;
      const length = argumentLength(arg, caller);
      if (length === null) continue;
      if (!readsLength(target, param.localId) || !paramReadOnly(target, paramIndex)) continue;
      const clone = cloneFor(target, paramIndex, length);
      if (clone === null) continue;
      return { ...call, callee: clone.name };
    }
    return call;
  }

  function rewriteFunction(fn: IrFunction): IrFunction {
    const candidates: Extract<IrExpr, { kind: "call" }>[] = [];
    const looped = callsInLoops(fn);
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (node) => {
        if (node.kind === "call" && looped.has(node) && specializeCall(node, fn) !== node)
          candidates.push(node);
        return true;
      },
    });
    if (!candidates.length) return fn;
    const byNode = new Map<IrExpr, IrExpr>();
    for (const call of candidates) byNode.set(call, specializeCall(call, fn));
    const body = transformStmtList(fn.body, {
      expr: (node) => byNode.get(node) ?? node,
      stmt: (statement) => statement,
    });
    return { ...fn, body };
  }

  const rewritten = mod.functions.map(rewriteFunction);
  const additions: IrFunction[] = [];
  for (let position = 0; position < pending.length; position++)
    additions.push(rewriteFunction(pending[position]!));
  if (!additions.length) return mod;
  return { ...mod, functions: [...rewritten, ...additions] };
}
