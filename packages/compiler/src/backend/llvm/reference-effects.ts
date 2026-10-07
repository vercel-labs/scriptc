import { preservesDynTest } from "./checked-value-lifetimes.js";
import { isStableReceiverOperand } from "../../ir/analysis.js";
import { isRefCounted, type IrExpr, type IrFunction, type IrStmt } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild, everyStmtList } from "../../ir/traverse.js";
import { borrowsStringInputs } from "./string-lifetimes.js";
import { borrowsMapReadInputs } from "./map-read-lifetimes.js";
import { byteNumberAccess } from "../../ir/byte-numbers.js";

type Call = IrExpr & { kind: "call" };

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
    case "ternary":
    case "seqExpr":
    case "fieldGet":
    case "recordGet":
    case "unionNarrow":
    case "unionIsTag":
    case "unionWrap":
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
      return true;
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
      return e.fn === "error.new" || e.fn === "error.nodeThrow" || isStableReceiverOperand(e, "");
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
    case "if":
    case "for":
    case "forOf":
    case "while":
    case "doWhile":
    case "block":
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

  constructor(
    functions: ReadonlyMap<string, IrFunction>,
    private readonly intrinsicCall: (call: Call) => boolean,
  ) {
    const callers = new Map<string, Set<string>>();
    const unsafe: string[] = [];
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
              (call) => {
                if (intrinsicCall(call)) return true;
                if (!functions.has(call.callee)) return false;
                let incoming = callers.get(call.callee);
                if (!incoming) callers.set(call.callee, (incoming = new Set()));
                incoming.add(fn.name);
                return true;
              },
              privateLocals,
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
      ) && everyExprChild(value, expr, stmt);
    this.expressions.set(value, result);
    return result;
  }

  preservesScope(body: IrStmt[]): boolean {
    return everyStmtList(body, {
      stmt: (stmt) => statementPreservesEdges(stmt),
      expr: (expr) => this.preserves(expr),
    });
  }
}
