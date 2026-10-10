import { preservesDynTest } from "./checked-value-lifetimes.js";
import { isStableReceiverOperand } from "../../ir/analysis.js";
import {
  isRefCounted,
  type IrClassDef,
  type IrExpr,
  type IrFunction,
  type IrStmt,
} from "../../ir/ir.js";
import { everyExprChild, everyStmtChild, everyStmtList } from "../../ir/traverse.js";
import { borrowsStringInputs } from "./string-lifetimes.js";
import { borrowsMapReadInputs } from "./map-read-lifetimes.js";
import { byteNumberAccess } from "../../ir/byte-numbers.js";

type Call = IrExpr & { kind: "call" };
type VirtualCall = IrExpr & { kind: "virtualCall" };

/** These native operations may update lastIndex and allocate results, but
 * never invoke user code or remove an existing reference edge. Results own
 * their payloads independently. Callback replacement uses a different IR. */
export function preservesRegexInputs(method: string): boolean {
  switch (method) {
    case "test":
    case "exec":
    case "match":
    case "search":
    case "matchAll":
    case "replace":
    case "replaceAll":
    case "split":
    case "source":
    case "flags":
    case "lastIndex":
    case "toString":
      return true;
    default:
      return false;
  }
}

function expressionPreservesEdges(
  e: IrExpr,
  call: (value: Call) => boolean,
  privateLocals?: ReadonlySet<string>,
  virtualCall?: (value: VirtualCall) => boolean,
): boolean {
  switch (e.kind) {
    case "numLit":
    case "boolLit":
    case "strLit":
    case "unitLit":
    case "varRef":
    case "bin":
    case "unary":
    case "incDec":
    case "toBool":
    case "logical":
    case "nullish":
    case "ternary":
    case "seqExpr":
    case "fieldGet":
    case "recordGet":
    case "unionNarrow":
    case "unionIsTag":
    case "unionWrap":
    case "downcast":
    case "upcast":
    case "instanceOf":
    case "strConcat":
    case "strEq":
    case "strCmp":
    case "arrayGet":
    case "arrayHas":
    case "arrayState":
    case "unionEq":
    case "unionFuncEq":
    case "dynScalarEq":
    case "caughtTest":
    case "caughtNarrow":
    case "caughtCheck":
    // An immortal class object, or a fresh one retaining captured boxes.
    case "classRef":
    // A chain evaluates its receiver and body (checked as children); its
    // bound receiver is a read.
    case "optChain":
    case "chainRecv":
      return true;
    // Formatting a primitive allocates a string and runs no user code.
    case "toString":
      return (
        e.operand.type.kind === "f64" ||
        e.operand.type.kind === "bool" ||
        e.operand.type.kind === "string"
      );
    case "virtualCall":
      return virtualCall?.(e) ?? false;
    case "dynTest":
      return preservesDynTest(e.test);
    case "assignExpr":
      return !isRefCounted(e.type) || privateLocals?.has(e.localId) === true;
    case "strIntrinsic":
      return borrowsStringInputs(e.method);
    case "regexIntrinsic":
      return preservesRegexInputs(e.method);
    case "mapIntrinsic":
    case "setIntrinsic":
      return borrowsMapReadInputs(e);
    case "libCall":
      // The typed-message constructor only allocates an error and retains
      // its message. The checked options constructor may invoke user code.
      // Math functions take numbers (the spread forms only read an array).
      return (
        e.fn === "error.new" ||
        e.fn === "error.nodeThrow" ||
        e.fn.startsWith("math.") ||
        isStableReceiverOperand(e, "")
      );
    case "call":
      return call(e);
    case "arrIntrinsic":
      return e.method === "length";
    case "bytesIntrinsic":
      return (
        e.method === "get" ||
        e.method === "length" ||
        e.method === "byteLength" ||
        e.method === "byteOffset" ||
        byteNumberAccess(e) !== null
      );
    default:
      return false;
  }
}

function statementPreservesEdges(s: IrStmt, privateLocals?: ReadonlySet<string>): boolean {
  switch (s.kind) {
    case "varDecl":
    case "exprStmt":
    case "return":
    case "throw":
    // Throws a fresh Error with a constant message (an unreachable trap).
    case "runtimeFence":
    case "if":
    case "for":
    case "forOf":
    case "while":
    case "doWhile":
    case "block":
    case "switch":
    case "break":
    case "continue":
    case "bytesSet":
      return true;
    case "assign":
      return !isRefCounted(s.value.type) || privateLocals?.has(s.localId) === true;
    case "fieldSet":
    case "recordSet":
      return !isRefCounted(s.value.type);
    default:
      return false;
  }
}

/** The module functions a virtual call can reach: the implementation the
 * static class inherits or declares, plus every override in its subtree.
 * Runtime classes keep their dispatch out of view, so they answer null. */
export class VirtualTargets {
  private readonly classes = new Map<string, IrClassDef>();
  private readonly children = new Map<string, IrClassDef[]>();
  private readonly cache = new Map<string, readonly string[] | null>();

  constructor(classes: readonly IrClassDef[]) {
    for (const cls of classes) this.classes.set(cls.name, cls);
    for (const cls of classes) {
      if (cls.base === undefined) continue;
      let list = this.children.get(cls.base);
      if (!list) this.children.set(cls.base, (list = []));
      list.push(cls);
    }
  }

  targets(className: string, method: string): readonly string[] | null {
    const key = `${className}\0${method}`;
    const known = this.cache.get(key);
    if (known !== undefined) return known;
    const result = this.compute(className, method);
    this.cache.set(key, result);
    return result;
  }

  private compute(className: string, method: string): readonly string[] | null {
    const declares = (cls: IrClassDef): "concrete" | "abstract" | null =>
      cls.methods?.includes(method) !== true
        ? null
        : cls.abstractMethods?.includes(method) === true
          ? "abstract"
          : "concrete";
    const targets = new Set<string>();
    // The nearest declaration on the static class or its ancestors.
    for (let name: string | undefined = className; name !== undefined;) {
      const cls = this.classes.get(name);
      if (!cls || cls.runtime) return null;
      const declared = declares(cls);
      if (declared === "concrete") targets.add(`%${cls.name}.${method}`);
      if (declared !== null) break;
      name = cls.base;
    }
    const pending = [...(this.children.get(className) ?? [])];
    while (pending.length > 0) {
      const cls = pending.pop()!;
      if (cls.runtime) return null;
      if (declares(cls) === "concrete") targets.add(`%${cls.name}.${method}`);
      pending.push(...(this.children.get(cls.name) ?? []));
    }
    return [...targets];
  }
}

/** Reference preservation is weaker than purity: scalar writes, allocation
 * and throwing are allowed. Caller owners and their reference edges must
 * survive until the consuming operation; callee-local rebinding is private.
 * Unknown calls, externally visible reference writes,
 * callbacks and suspension stay conservative, including inside recursion.
 * Facts belong to one finalized module, never serialized or reused after a
 * transform. Scan bodies once and propagate rejections through reverse edges. */
export class ReferenceEffects {
  readonly functions = new Set<string>();
  private readonly expressions = new Map<IrExpr, boolean>();

  private readonly virtualTargets: VirtualTargets | null;

  constructor(
    functions: ReadonlyMap<string, IrFunction>,
    private readonly intrinsicCall: (call: Call) => boolean,
    classes?: readonly IrClassDef[],
  ) {
    this.virtualTargets = classes ? new VirtualTargets(classes) : null;
    const callers = new Map<string, Set<string>>();
    const unsafe: string[] = [];
    const dependOn = (callee: string, caller: string): boolean => {
      if (!functions.has(callee)) return false;
      let incoming = callers.get(callee);
      if (!incoming) callers.set(callee, (incoming = new Set()));
      incoming.add(caller);
      return true;
    };
    for (const fn of functions.values()) {
      // Rebinding a callee's unboxed local cannot replace the caller's
      // owner. The same write in a later caller operand still must reject
      // borrowing, so these facts apply only while summarizing this body.
      const privateLocals = new Set(
        fn.locals.filter((local) => !local.boxed).map((local) => local.id),
      );
      const safe =
        !fn.async &&
        !fn.generator &&
        !fn.captures &&
        !fn.classCaptures &&
        everyStmtList(fn.body, {
          stmt: (stmt) => statementPreservesEdges(stmt, privateLocals),
          expr: (e) =>
            expressionPreservesEdges(
              e,
              (call) => intrinsicCall(call) || dependOn(call.callee, fn.name),
              privateLocals,
              // Every reachable implementation must preserve edges; the
              // dispatch itself passes owned arguments that callees release.
              (call) =>
                this.virtualTargets
                  ?.targets(call.className, call.method)
                  ?.every((target) => dependOn(target, fn.name)) ?? false,
            ),
        });
      if (safe) this.functions.add(fn.name);
      else unsafe.push(fn.name);
    }
    for (let i = 0; i < unsafe.length; i++) {
      const incoming = callers.get(unsafe[i]!);
      if (!incoming) continue;
      for (const caller of incoming) {
        if (this.functions.delete(caller)) unsafe.push(caller);
      }
    }
  }

  preserves(value: IrExpr): boolean {
    const known = this.expressions.get(value);
    if (known !== undefined) return known;
    const expr = (node: IrExpr): boolean => this.preserves(node);
    const stmt = (node: IrStmt): boolean =>
      statementPreservesEdges(node) && everyStmtChild(node, expr, stmt);
    const result =
      expressionPreservesEdges(
        value,
        (call) => this.intrinsicCall(call) || this.functions.has(call.callee),
        undefined,
        (call) => this.virtualPreserves(call),
      ) && everyExprChild(value, expr, stmt);
    this.expressions.set(value, result);
    return result;
  }

  virtualPreserves(call: VirtualCall): boolean {
    return (
      this.virtualTargets
        ?.targets(call.className, call.method)
        ?.every((target) => this.functions.has(target)) ?? false
    );
  }

  preservesScope(body: IrStmt[]): boolean {
    return everyStmtList(body, {
      stmt: (stmt) => statementPreservesEdges(stmt),
      expr: (expr) => this.preserves(expr),
    });
  }
}
