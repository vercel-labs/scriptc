import * as ts from "../../ts7/adapter.js";
import { locOf } from "../../program.js";
import { resolve } from "node:path";
import { isWorkerConstructor, workerModulePath, workerSourcePath } from "../../worker-target.js";
import { tsgoPath } from "../../dts-paths.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  UNDEFINED_T,
  isFfiCallbackParam,
  type IrExpr,
  type SrcLoc,
} from "../../../ir/ir.js";
import type { Lowerer } from "../lowerer.js";

export function lowerWorkerMetadata(member: string, loc: SrcLoc): IrExpr | null {
  switch (member) {
    case "isMainThread":
      return { kind: "libCall", fn: "worker.isMainThread", args: [], type: BOOL, loc };
    case "threadId":
      return { kind: "libCall", fn: "worker.threadId", args: [], type: F64, loc };
    case "workerData":
      return { kind: "libCall", fn: "worker.data", args: [], type: DYN, loc };
    case "parentPort":
      return { kind: "libCall", fn: "worker.parentPort", args: [], type: DYN, loc };
    case "isInternalThread":
      return { kind: "boolLit", value: false, type: BOOL, loc };
    default:
      return null;
  }
}

export function lowerWorkerNew(lowerer: Lowerer, expression: ts.NewExpression): IrExpr | null {
  const constructor = expression.expression;
  if (!isWorkerConstructor(lowerer.program, constructor)) return null;
  const args = expression.arguments ?? [];
  if (args.length < 1 || args.length > 2 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      "Worker constructor arguments",
      expression,
      "use new Worker(filename, options?)",
    );
  }
  const filename = args[0]!;
  const path = workerModulePath(lowerer.program, filename);
  const root =
    path === null
      ? undefined
      : lowerer.workerTargetIdByPath.get(tsgoPath(resolve(workerSourcePath(path))));
  if (root === undefined) {
    lowerer.noLowering(
      "this Worker entry point",
      filename,
      "the worker entry must resolve to a statically compiled source file",
    );
  }
  if (lowerer.dynamic || lowerer.targetPlatform === "wasi") {
    lowerer.noLowering(
      "Worker execution in this target",
      expression,
      "use a native static executable",
    );
  }
  if (
    lowerer.ffiImports.some((entry) =>
      entry.params.some(
        (parameter) => isFfiCallbackParam(parameter) && parameter.callback.invoke === "foreign",
      ),
    )
  ) {
    lowerer.noLowering(
      "workers with foreign-thread native callbacks",
      expression,
      "native callbacks in worker executables must run on their owning script thread",
    );
  }
  lowerer.usesWorkers = true;
  const loc = locOf(expression);
  const options: IrExpr = args[1]
    ? lowerer.lowerExprExpecting(args[1], DYN)
    : {
        kind: "dynFrom",
        value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
        type: DYN,
        loc,
      };
  return {
    kind: "libCall",
    fn: "worker.new",
    args: [
      { kind: "numLit", value: root, type: F64, loc },
      { kind: "strLit", value: path!, type: STRING, loc },
      options,
    ],
    type: DYN,
    loc,
  };
}
