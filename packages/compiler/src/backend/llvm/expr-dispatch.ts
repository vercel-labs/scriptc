/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { IrExpr } from "../../ir/ir.js";
import type { LlvmEmitterContext, ExprOf, LlValue } from "./expr-context.js";

export function emitJsInteropExpr(host: LlvmEmitterContext, e: ExprOf<"jsMarshal" | "jsOp" | "jsExit" | "jsBridgePromise">): LlValue {
    const B = host.B;
    switch (e.kind) {
      case "jsMarshal":
        return host.emitJsMarshal(e);
      case "jsOp":
        return host.emitJsOp(e);
      case "jsExit":
        return host.emitJsExit(e);
      case "jsBridgePromise": {
        // Island → static promise bridge: a fresh pending ScrPromise the
        // engine promise settles. Operand borrowed; the +1 promise joins
        // the frame. Pending check like other island ops.
        const v = host.emitExpr(e.value);
        const payload =
          e.type.kind === "promise" && e.type.inner.kind === "void"
            ? 0 // SCR_ISLP_VOID
            : e.type.kind === "promise" && e.type.inner.kind === "array" && e.type.inner.elem.kind === "jsval"
              ? 5 // SCR_ISLP_JSVAL_ARR: the Array.isArray-gated by-reference exit at settle
              : 4; // SCR_ISLP_JSVAL
        host.declare(`declare ptr @scr_jsval_bridge_promise(ptr, i32)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_bridge_promise(ptr ${v.name}, i32 ${payload})`);
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  }

export function emitExpr(host: LlvmEmitterContext, e: IrExpr): LlValue {
    switch (e.kind) {
      case "numLit":
      case "boolLit":
      case "strLit":
      case "unitLit":
      case "varRef":
        return host.emitLiteralExpr(e);
      case "bin":
      case "unary":
      case "incDec":
      case "fieldIncDec":
      case "assignExpr":
      case "seqExpr":
        return host.emitOperatorExpr(e);
      case "dynDestrCheck":
      case "dynIterN":
      case "toBool":
      case "logical":
      case "ternary":
      case "optChain":
      case "chainRecv":
      case "orDefault":
      case "nullish":
        return host.emitControlExpr(e);
      case "strConcat":
      case "strEq":
      case "strCmp":
      case "toString":
      case "strIntrinsic":
      case "regexLit":
      case "templateStrings":
      case "regexIntrinsic":
        return host.emitStringExpr(e);
      case "arrayLit":
      case "arrayNewLen":
      case "arrayGet":
      case "arrIntrinsic":
      case "bytesNew":
      case "bytesIntrinsic":
      case "mapNew":
      case "mapIntrinsic":
      case "setIntrinsic":
      case "setNew":
        return host.emitContainerExpr(e);
      case "call":
      case "ffiCall":
      case "closure":
      case "callValue":
      case "selfRef":
      case "new":
      case "classRef":
      case "newValue":
      case "instanceOfValue":
      case "promiseVoidWiden":
      case "upcast":
      case "downcast":
      case "instanceOf":
      case "virtualCall":
        return host.emitCallExpr(e);
      case "fieldGet":
      case "recordGet":
      case "recordLit":
      case "recordClone":
      case "recordKeyGet":
      case "recordOvfKeys":
        return host.emitRecordExpr(e);
      case "dynFrom":
      case "dynFromJsval":
      case "dynCall":
      case "dynInvoke":
      case "dynArrLit":
      case "dynObjLit":
      case "unionWrap":
      case "unionNarrow":
      case "unionDisc":
      case "unionKeyGet":
      case "unionIsTag":
      case "dynKeyGet":
      case "dynHasKey":
      case "dynScalarEq":
      case "dynTest":
      case "unionEq":
      case "unionFuncEq":
      case "caughtTest":
      case "caughtCheck":
      case "caughtNarrow":
      case "caughtToDyn":
        return host.emitDynamicExpr(e);
      case "intrinsic":
        return host.emitIntrinsicExpr(e);
      case "jsonStringify":
      case "dynCheck":
        return host.emitSerializationExpr(e);
      case "yieldExpr":
      case "genResume":
      case "awaitExpr":
      case "awaitUnionExpr":
      case "newPromise":
      case "promiseWithResolvers":
        return host.emitAsyncExpr(e);
      case "jsMarshal":
      case "jsOp":
      case "jsExit":
      case "jsBridgePromise":
        return host.emitJsInteropExpr(e);
      case "libCall":
        return host.emitLibCall(e);
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  }
