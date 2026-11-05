/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { type IrExpr } from "../../ir/ir.js";
import type { LlvmEmitterContext, LlValue } from "./expr-context.js";
import { emitUnionRetype } from "./expr-records.js";

export function emitExpr(host: LlvmEmitterContext, e: IrExpr): LlValue {
  switch (e.kind) {
    case "numLit":
    case "boolLit":
    case "strLit":
    case "moduleNsRef":
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
    case "arrayHas":
    case "arrayState":
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
    case "recordOvfHas":
    case "recordNullProto":
    case "recordHas":
    case "fieldAbsent":
      return host.emitRecordExpr(e);
    case "dynFrom":
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
      if (e.name.startsWith("promise.")) host.usesPromises = true;
      return host.emitIntrinsicExpr(e);
    case "jsonStringify":
    case "dynCheck":
      return host.emitSerializationExpr(e);
    case "yieldExpr":
    case "genResume":
    case "awaitExpr":
    case "awaitUnionExpr":
      return host.emitAsyncExpr(e);
    case "newPromise":
    case "promiseWithResolvers":
      host.usesPromises = true;
      return host.emitAsyncExpr(e);
    case "libCall":
      return host.emitLibCall(e);
    case "unionRetype":
      return emitUnionRetype(host, e);
    default: {
      const _exhaustive: never = e;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}
