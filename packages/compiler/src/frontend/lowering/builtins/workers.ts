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
  VOID,
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
    case "resourceLimits":
      return { kind: "libCall", fn: "worker.resourceLimits", args: [], type: DYN, loc };
    case "threadName":
      return { kind: "libCall", fn: "worker.threadName", args: [], type: DYN, loc };
    default:
      return null;
  }
}

export function lowerWorkerNew(lowerer: Lowerer, expression: ts.NewExpression): IrExpr | null {
  const constructor = expression.expression;
  if (!isWorkerConstructor(lowerer.program, constructor)) return null;
  const args = expression.arguments?.nodes ?? [];
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
  if (lowerer.targetPlatform === "wasi") {
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
  refuseHeapLimits(lowerer, args[1]);
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
  const create: IrExpr = {
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
  if (!capturesStdio(args[1])) return create;
  return {
    kind: "seqExpr",
    stmts: [
      {
        kind: "exprStmt",
        expr: { kind: "libCall", fn: "stream.workerStdio", args: [], type: VOID, loc },
        loc,
      },
    ],
    result: create,
    type: DYN,
    loc,
  };
}

/** True when the options are not a literal, or a literal whose stdout,
 * stderr or stdin member is not the literal false: worker.stdout,
 * worker.stderr and worker.stdin then need the stream unit. */
function capturesStdio(options: ts.Expression | undefined): boolean {
  if (!options) return false;
  if (!ts.isObjectLiteralExpression(options)) return true;
  return options.properties.nodes.some((option) => {
    if (ts.isSpreadAssignment(option)) return true;
    if (!option.name) return false;
    const name = propertyNameText(option.name);
    if (name !== "stdout" && name !== "stderr" && name !== "stdin") return name === undefined;
    return !(
      ts.isPropertyAssignment(option) && option.initializer.kind === ts.SyntaxKind.FalseKeyword
    );
  });
}

const HEAP_LIMITS = new Set([
  "maxOldGenerationSizeMb",
  "maxYoungGenerationSizeMb",
  "codeRangeSizeMb",
]);

/** resourceLimits' V8 heap fields, when an options literal spells them
 * with numbers (Node ignores other values; the runtime refuses the rest). */
function refuseHeapLimits(lowerer: Lowerer, options: ts.Expression | undefined): void {
  if (!options || !ts.isObjectLiteralExpression(options)) return;
  for (const option of options.properties.nodes) {
    if (!ts.isPropertyAssignment(option) || propertyNameText(option.name) !== "resourceLimits")
      continue;
    if (!ts.isObjectLiteralExpression(option.initializer)) continue;
    for (const limit of option.initializer.properties.nodes) {
      if (!ts.isPropertyAssignment(limit)) continue;
      const name = propertyNameText(limit.name);
      if (name === undefined || !HEAP_LIMITS.has(name)) continue;
      const type = lowerer.checker.getTypeAtLocation(limit.initializer);
      if (!(type.flags & ts.TypeFlags.NumberLike)) continue;
      lowerer.noLowering(
        `Worker resourceLimits.${name}`,
        limit,
        "worker threads have no separate V8 heap; resourceLimits supports stackSizeMb",
      );
    }
  }
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

/** True when `node`'s type is worker_threads' `name` class (also reached
 * through its global). */
function isWorkerThreadsClass(lowerer: Lowerer, node: ts.Expression, name: string): boolean {
  const t = lowerer.checker.getTypeAtLocation(node);
  const sym = t.getSymbol();
  if (sym === undefined || ts.symbolName(sym) !== name) return false;
  return sym.declarations.some((d) => {
    if (!ts.isClassDeclaration(d) && !ts.isInterfaceDeclaration(d)) return false;
    if (!lowerer.isStdlibFile(ts.getSourceFileOfNode(d))) return false;
    let up: ts.Node | undefined = d.parent;
    while (up) {
      if (ts.isModuleDeclaration(up) && ts.isStringLiteral(up.name))
        return up.name.text === "worker_threads" || up.name.text === "node:worker_threads";
      up = up.parent;
    }
    return false;
  });
}

/** new MessageChannel(): { port1, port2 }, two entangled MessagePorts. */
export function lowerMessageChannelNew(
  lowerer: Lowerer,
  expression: ts.NewExpression,
): IrExpr | null {
  if (!isWorkerThreadsClass(lowerer, expression, "MessageChannel")) return null;
  if ((expression.arguments?.nodes ?? []).length > 0) {
    lowerer.noLowering(
      "MessageChannel constructor arguments",
      expression,
      "use new MessageChannel()",
    );
  }
  if (lowerer.targetPlatform === "wasi") {
    lowerer.noLowering(
      "MessageChannel in this target",
      expression,
      "use a native static executable",
    );
  }
  lowerer.usesWorkers = true;
  return { kind: "libCall", fn: "worker.channel", args: [], type: DYN, loc: locOf(expression) };
}

/** receiveMessageOnPort(port): { message } or undefined. */
export function lowerReceiveMessageOnPort(lowerer: Lowerer, call: ts.CallExpression): IrExpr {
  const args = call.arguments.nodes;
  if (args.length > 1 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(`receiveMessageOnPort with ${args.length} arguments`, call);
  }
  lowerer.usesWorkers = true;
  const loc = locOf(call);
  const port: IrExpr = args[0]
    ? lowerer.lowerExprExpecting(args[0], DYN)
    : {
        kind: "dynFrom",
        value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
        type: DYN,
        loc,
      };
  return {
    kind: "libCall",
    fn: "worker.receiveMessageOnPort",
    args: [port],
    type: DYN,
    loc,
  };
}

/** new BroadcastChannel(name): the EventTarget unit's half installs
 * first, then the channel opens (the name converts at runtime). */
export function lowerBroadcastChannelNew(
  lowerer: Lowerer,
  expression: ts.NewExpression,
): IrExpr | null {
  if (!isWorkerThreadsClass(lowerer, expression, "BroadcastChannel")) return null;
  const args = expression.arguments?.nodes ?? [];
  if (args.length > 1 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `BroadcastChannel constructor with ${args.length} arguments`,
      expression,
      "use new BroadcastChannel(name)",
    );
  }
  if (lowerer.targetPlatform === "wasi") {
    lowerer.noLowering(
      "BroadcastChannel in this target",
      expression,
      "use a native static executable",
    );
  }
  lowerer.usesWorkers = true;
  const loc = locOf(expression);
  return {
    kind: "seqExpr",
    stmts: [
      {
        kind: "exprStmt",
        expr: { kind: "libCall", fn: "event.broadcastInstall", args: [], type: VOID, loc },
        loc,
      },
    ],
    result: {
      kind: "libCall",
      fn: "worker.broadcastChannel",
      args: [
        {
          kind: "dynArrLit",
          elems: args.map((a) => lowerer.lowerExprExpecting(a, DYN)),
          type: DYN,
          loc,
        },
      ],
      type: DYN,
      loc,
    },
    type: DYN,
    loc,
  };
}

/** setEnvironmentData(key, value?) and getEnvironmentData(key): this
 * thread's map, cloned into each Worker it constructs. */
export function lowerEnvironmentData(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: "setEnvironmentData" | "getEnvironmentData",
): IrExpr {
  const args = call.arguments.nodes;
  const arity = member === "setEnvironmentData" ? 2 : 1;
  if (args.length > arity || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(`${member} with ${args.length} arguments`, call);
  }
  if (lowerer.targetPlatform === "wasi") {
    lowerer.noLowering(`${member} in this target`, call, "use a native static executable");
  }
  lowerer.usesWorkers = true;
  const loc = locOf(call);
  const lowered: IrExpr[] = [];
  for (let i = 0; i < arity; i++) {
    lowered.push(
      args[i]
        ? lowerer.lowerExprExpecting(args[i]!, DYN)
        : {
            kind: "dynFrom",
            value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
            type: DYN,
            loc,
          },
    );
  }
  return {
    kind: "libCall",
    fn: member === "setEnvironmentData" ? "worker.setEnvironmentData" : "worker.getEnvironmentData",
    args: lowered,
    type: member === "setEnvironmentData" ? VOID : DYN,
    loc,
  };
}

/** markAsUncloneable(value): structuredClone and postMessage then throw
 * DataCloneError for the value (scr_json.c). It needs no worker runtime. */
export function lowerUncloneable(lowerer: Lowerer, call: ts.CallExpression): IrExpr {
  const args = call.arguments.nodes;
  if (args.length > 1 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(`markAsUncloneable with ${args.length} arguments`, call);
  }
  const loc = locOf(call);
  const value: IrExpr = args[0]
    ? lowerer.lowerExprExpecting(args[0], DYN)
    : {
        kind: "dynFrom",
        value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
        type: DYN,
        loc,
      };
  return { kind: "libCall", fn: "dyn.markUncloneable", args: [value], type: VOID, loc };
}

/** markAsUntransferable(value) and isMarkedAsUntransferable(value): marks
 * kept by this thread (an ArrayBuffer's on its storage). */
export function lowerUntransferable(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: "markAsUntransferable" | "isMarkedAsUntransferable",
): IrExpr {
  const args = call.arguments.nodes;
  if (args.length > 1 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(`${member} with ${args.length} arguments`, call);
  }
  if (lowerer.targetPlatform === "wasi") {
    lowerer.noLowering(`${member} in this target`, call, "use a native static executable");
  }
  lowerer.usesWorkers = true;
  const loc = locOf(call);
  const value: IrExpr = args[0]
    ? lowerer.lowerExprExpecting(args[0], DYN)
    : {
        kind: "dynFrom",
        value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
        type: DYN,
        loc,
      };
  return member === "markAsUntransferable"
    ? { kind: "libCall", fn: "worker.markUntransferable", args: [value], type: VOID, loc }
    : { kind: "libCall", fn: "worker.isMarkedUntransferable", args: [value], type: BOOL, loc };
}
