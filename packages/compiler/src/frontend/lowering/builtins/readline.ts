import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrType,
  type IrStmt,
  type SrcLoc,
  STRING,
  UNDEFINED_T,
  VOID,
  arrayOf,
  BYTES_U8,
} from "../../../ir/ir.js";
import { boolLit, dynUndefinedExpr, numLit } from "../../../ir/build.js";
import { READLINE_DOCUMENTED_OPTIONS, fenceOrDropOptionKey } from "../surfaces.js";
import { streamSidesOf } from "../lower-stream.js";
import type { IrLibFn } from "../../../ir/builtin-signatures.js";
import { voidizedCallback } from "../lower-server.js";
import { builtinImportOf } from "./module-bindings.js";

/** The ambient module declaring `d`, or null. */
function ambientModuleOf(d: ts.Node): string | null {
  let up: ts.Node | undefined = d.parent;
  while (up) {
    if (ts.isModuleDeclaration(up) && ts.isStringLiteral(up.name)) return up.name.text;
    up = up.parent;
  }
  return null;
}

function isReadlineModule(spec: string | null): boolean {
  return (
    spec === "readline" ||
    spec === "node:readline" ||
    spec === "readline/promises" ||
    spec === "node:readline/promises"
  );
}

/** True when `node`'s checker type is a readline Interface (stdlib
 * provenance + the enclosing "readline" or "readline/promises" ambient
 * module — the name alone is too generic). The interface maps to an f64
 * handle, so the IR type cannot discriminate it from a plain number. */
export function isReadlineTyped(lowerer: Lowerer, node: ts.Expression): boolean {
  const t = lowerer.checker.getTypeAtLocation(node);
  const sym = t.getAliasSymbol() ?? t.getSymbol();
  if (sym === undefined || ts.symbolName(sym) !== "Interface") return false;
  return sym.declarations.some((d) => {
    if (!ts.isClassDeclaration(d) && !ts.isInterfaceDeclaration(d)) return false;
    if (!lowerer.isStdlibFile(ts.getSourceFileOfNode(d))) return false;
    return isReadlineModule(ambientModuleOf(d));
  });
}

/** `rl.cursor`: @types/node declares a number, but an interface that is
 * not a terminal answers undefined, so the read keeps its
 * `number | undefined` union. */
export function isOptionalReadlineCursorRead(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): boolean {
  return (
    expr.name.text === "cursor" &&
    !expr.questionDotToken &&
    isReadlineTyped(lowerer, expr.expression) &&
    lowerer.isStdlibMember(expr)
  );
}

/** The runtime's listener event numbers (scr_readline.c). */
const RL_EVENTS: Record<string, number> = {
  line: 0,
  close: 1,
  pause: 2,
  resume: 3,
  error: 4,
  history: 5,
  SIGINT: 6,
  SIGTSTP: 7,
  SIGCONT: 8,
};

const RL_EVENT_LIST =
  '"line", "close", "pause", "resume", "error", "history", "SIGINT", "SIGTSTP" and "SIGCONT"';

/** True when the call's resolved signature answers a Promise — the
 * readline/promises question. */
function returnsPromise(lowerer: Lowerer, call: ts.CallExpression): boolean {
  const t = lowerer.checker.getTypeAtLocation(call);
  return (ts.symbolNameOf(t.getSymbol()) ?? "") === "Promise";
}

/** The `{ signal }` options argument of the promise question: the signal
 * expression, or null when absent. Other members fence by name. */
function questionSignal(lowerer: Lowerer, node: ts.Expression | undefined): ts.Expression | null {
  if (node === undefined) return null;
  if (!ts.isObjectLiteralExpression(node)) {
    lowerer.noLowering(
      "readline/promises question options that are not an object literal",
      node,
      "write the options inline: question(query, { signal })",
    );
  }
  let signal: ts.Expression | null = null;
  for (const p of node.properties.nodes) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "signal") {
      signal = p.initializer;
      continue;
    }
    lowerer.noLowering(
      "readline/promises question with this option",
      p,
      "signal is the supported question option",
    );
  }
  return signal;
}

/** True when `node`'s checker type is readline/promises' Readline. */
function isReadlineUiTyped(lowerer: Lowerer, node: ts.Expression): boolean {
  const t = lowerer.checker.getTypeAtLocation(node);
  const sym = t.getAliasSymbol() ?? t.getSymbol();
  if (sym === undefined || ts.symbolName(sym) !== "Readline") return false;
  return sym.declarations.some((d) => {
    if (!ts.isClassDeclaration(d) && !ts.isInterfaceDeclaration(d)) return false;
    if (!lowerer.isStdlibFile(ts.getSourceFileOfNode(d))) return false;
    const spec = ambientModuleOf(d);
    return spec === "readline/promises" || spec === "node:readline/promises";
  });
}

/** The process.stdout/stderr target (1/2) of `node`, or 0. */
function processOutputOf(lowerer: Lowerer, node: ts.Expression): 0 | 1 | 2 {
  if (!ts.isPropertyAccessExpression(node)) return 0;
  const member = lowerer.stdlibGlobalMember(node, "process");
  return member === "stdout" ? 1 : member === "stderr" ? 2 : 0;
}

/** new Readline(stream, options?) from readline/promises: the stream is
 * process.stdout, process.stderr or a writable stream (checked with
 * isWritable at runtime), the options an object literal with a boolean
 * autoCommit. Null for other constructors. */
export function lowerReadlineUiNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (!isReadlineUiTyped(lowerer, expr)) return null;
  const loc = locOf(expr);
  const args = expr.arguments?.nodes ?? [];
  if (args.length < 1 || args.length > 2 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(`new Readline with ${args.length} arguments`, expr);
  }
  const fd = processOutputOf(lowerer, args[0]!);
  let stream: IrExpr | null = null;
  if (fd === 0) {
    stream = lowerer.lowerExpr(args[0]!);
    const info =
      stream.type.kind === "object" ? lowerer.classes.get(stream.type.className) : undefined;
    const sides = streamSidesOf(lowerer, info);
    if (sides !== "w" && sides !== "rw") {
      lowerer.noLowering(
        "new Readline with this stream",
        args[0]!,
        "process.stdout, process.stderr and writable streams are the supported streams",
      );
    }
  }
  let autoCommit: IrExpr = boolLit(false, loc);
  const opts = args[1];
  if (opts !== undefined && !isNullish(opts)) {
    if (!ts.isObjectLiteralExpression(opts)) {
      lowerer.noLowering(
        "new Readline with options that are not an object literal",
        opts,
        "write the options inline: new Readline(stream, { autoCommit: true })",
      );
    }
    for (const p of opts.properties.nodes) {
      if (
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === "autoCommit" &&
        !isNullish(p.initializer)
      ) {
        if (!(lowerer.typeOf(p.initializer).flags & ts.TypeFlags.BooleanLike)) {
          lowerer.noLowering(
            "the Readline option 'autoCommit' with a value that is not a boolean",
            p.initializer,
          );
        }
        autoCommit = lowerer.lowerExprExpecting(p.initializer, BOOL);
      } else if (
        !(ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "autoCommit")
      ) {
        lowerer.noLowering(
          "new Readline with this option",
          p,
          "autoCommit is the supported option",
        );
      }
    }
  }
  if (stream !== null) {
    return { kind: "libCall", fn: "rl.uiOpenStream", args: [stream, autoCommit], type: F64, loc };
  }
  return { kind: "libCall", fn: "rl.uiOpen", args: [numLit(fd, loc), autoCommit], type: F64, loc };
}

/** Readline methods: cursorTo(x, y?), moveCursor(dx, dy), clearLine(dir),
 * clearScreenDown() and rollback() answer the receiver; commit() answers
 * a promise. */
function lowerReadlineUiCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr {
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments.nodes;
  const plan: Record<string, [IrLibFn, number, number]> = {
    cursorTo: ["rl.uiCursorTo", 1, 2],
    moveCursor: ["rl.uiMoveCursor", 2, 2],
    clearLine: ["rl.uiClearLine", 1, 1],
    clearScreenDown: ["rl.uiClearScreenDown", 0, 0],
    rollback: ["rl.uiRollback", 0, 0],
    commit: ["rl.uiCommit", 0, 0],
  };
  const entry = plan[name];
  if (
    entry === undefined ||
    args.length < entry[1] ||
    args.length > entry[2] ||
    args.some(ts.isSpreadElement)
  ) {
    lowerer.noLowering(
      `readlinePromises.Readline.${name}`,
      call,
      "cursorTo, moveCursor, clearLine, clearScreenDown, commit and rollback are the supported Readline members",
      lowerer.checker.getSymbolAtLocation(access.name),
    );
  }
  const l = lowerer.declareHiddenLocal("%rlUi", F64);
  const recv: IrExpr = { kind: "varRef", localId: l.id, type: F64, loc };
  const stmts: IrStmt[] = [
    {
      kind: "varDecl",
      localId: l.id,
      init: lowerer.lowerExprExpecting(access.expression, F64),
      loc,
    },
  ];
  if (name === "commit") {
    return {
      kind: "seqExpr",
      stmts,
      result: {
        kind: "libCall",
        fn: "rl.uiCommit",
        args: [recv],
        type: { kind: "promise", inner: VOID },
        loc,
      },
      type: { kind: "promise", inner: VOID },
      loc,
    };
  }
  const number = (n: ts.Expression): IrExpr => {
    if (!(lowerer.typeOf(n).flags & ts.TypeFlags.NumberLike)) {
      lowerer.noLowering(`Readline.${name} with an argument that is not a number`, n);
    }
    return lowerer.lowerExprExpecting(n, F64);
  };
  const values: IrExpr[] = [recv];
  if (name === "cursorTo") {
    // cursorTo(x, y?): [handle, x, whether y is given, y]
    const y = args[1];
    const hasY = y !== undefined && !isNullish(y);
    values.push(number(args[0]!), boolLit(hasY, loc), hasY ? number(y) : numLit(0, loc));
  } else {
    for (const n of args) values.push(number(n));
  }
  stmts.push({
    kind: "exprStmt",
    expr: { kind: "libCall", fn: entry[0], args: values, type: VOID, loc },
    loc,
  });
  return { kind: "seqExpr", stmts, result: recv, type: F64, loc };
}

/** The module ("readline" or "readline/promises") whose Interface class
 * `node` names, or null. */
function interfaceClassModule(lowerer: Lowerer, node: ts.Expression): string | null {
  const builtin = ts.isIdentifier(node)
    ? builtinImportOf(lowerer, node)
    : ts.isPropertyAccessExpression(node) && !node.questionDotToken
      ? lowerer.builtinMemberOf(node)
      : null;
  if (builtin?.member !== "Interface") return null;
  return builtin.module === "readline" || builtin.module === "readline/promises"
    ? builtin.module
    : null;
}

/** `new readline.Interface(...)` and `new readlinePromises.Interface(...)`:
 * the constructor createInterface calls, with the same arguments. Null for
 * other constructors. */
export function lowerReadlineInterfaceNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  const module = interfaceClassModule(lowerer, expr.expression);
  if (module === null) return null;
  return lowerReadlineCreateCall(lowerer, expr, locOf(expr), module === "readline/promises");
}

/** `rl instanceof readline.Interface` and `rl instanceof
 * readlinePromises.Interface` over a readline Interface: an interface is
 * an instance of the class of the module that created it (Node's
 * readline/promises Interface does not extend node:readline's). Null for
 * other instanceof tests. */
export function lowerReadlineInstanceof(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  const module = interfaceClassModule(lowerer, expr.right);
  if (module === null || !isReadlineTyped(lowerer, expr.left)) return null;
  const loc = locOf(expr);
  const recv = lowerer.lowerExprExpecting(expr.left, F64);
  const isPromises: IrExpr = {
    kind: "libCall",
    fn: "rl.isPromises",
    args: [recv],
    type: BOOL,
    loc,
  };
  if (module === "readline/promises") return isPromises;
  return { kind: "unary", op: "!", operand: isPromises, type: BOOL, loc };
}

/** `rl[Symbol.dispose]()` on a readline Interface: Node's dispose method
 * calls close(), which does nothing on a closed interface. Null for other
 * element-access calls. */
export function lowerReadlineDisposeCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  const access = call.expression;
  if (!ts.isElementAccessExpression(access) || access.questionDotToken || call.questionDotToken) {
    return null;
  }
  let key = access.argumentExpression;
  while (ts.isParenthesizedExpression(key)) key = key.expression;
  if (
    !ts.isPropertyAccessExpression(key) ||
    lowerer.stdlibGlobalMember(key, "Symbol") !== "dispose"
  ) {
    return null;
  }
  if (!isReadlineTyped(lowerer, access.expression)) return null;
  if (call.arguments.nodes.length > 0) {
    lowerer.noLowering("readline.Interface[Symbol.dispose] with arguments", call);
  }
  const recv = lowerer.lowerExprExpecting(access.expression, F64);
  return { kind: "libCall", fn: "rl.close", args: [recv], type: VOID, loc: locOf(call) };
}

/** A question query or setPrompt argument: the string, or for a value
 * that need not be one (JavaScript), the checked-dynamic value, which the
 * runtime writes the way Node's kWriteToOutput does (dyn: true). */
function lowerPromptArg(lowerer: Lowerer, node: ts.Expression): { value: IrExpr; dyn: boolean } {
  if (lowerer.typeOf(node).flags & ts.TypeFlags.StringLike) {
    return { value: lowerer.lowerExprExpecting(node, STRING), dyn: false };
  }
  const value = lowerer.lowerExpr(node);
  if (value.type.kind === "string") return { value, dyn: false };
  return { value: lowerer.coerceInto(node, value, DYN), dyn: true };
}

/** Method calls on readline Interface receivers (both modules):
 * - question(query, cb) — the callback form; question(query, { signal }?)
 *   — the promise form (readline/promises);
 * - close(), pause(), resume(), prompt(preserveCursor?), setPrompt(p),
 *   getPrompt(), write(data, key?);
 * - on/once/addListener for 'line' ((input: string) or no parameters),
 *   'error' ((err: Error) or no parameters), 'history' ((history:
 *   string[]) or no parameters), and 'close'/'pause'/'resume'/'SIGINT'/
 *   'SIGTSTP'/'SIGCONT' (no parameters); as an expression the call yields
 *   the interface, so registrations chain.
 * Everything else the lib declares fences member-qualified. Null for
 * non-Interface receivers. */
export function lowerReadlineMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (isReadlineUiTyped(lowerer, access.expression) && lowerer.isStdlibMember(access)) {
    return lowerReadlineUiCall(lowerer, call, access);
  }
  if (!isReadlineTyped(lowerer, access.expression)) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments.nodes;
  const receiver = (): IrExpr => lowerer.lowerExprExpecting(access.expression, F64);
  if (
    name === "question" &&
    returnsPromise(lowerer, call) &&
    args.length >= 1 &&
    args.length <= 2
  ) {
    const recv = receiver();
    const query = lowerPromptArg(lowerer, args[0]!);
    const signal = questionSignal(lowerer, args[1]);
    const type = { kind: "promise", inner: STRING } as const;
    if (signal === null) {
      const fn = query.dyn ? "rl.questionAsyncDyn" : "rl.questionAsync";
      return { kind: "libCall", fn, args: [recv, query.value], type, loc };
    }
    const sig = lowerer.lowerExprExpecting(signal, DYN);
    const fn = query.dyn ? "rl.questionAsyncSignalDyn" : "rl.questionAsyncSignal";
    return { kind: "libCall", fn, args: [recv, query.value, sig], type, loc };
  }
  if (name === "question" && args.length === 2) {
    const recv = receiver();
    const query = lowerPromptArg(lowerer, args[0]!);
    const cb = lowerer.lowerExpr(args[1]!);
    if (cb.type.kind !== "func" || cb.type.ret.kind !== "void" || cb.type.params.length > 1) {
      lowerer.unsupported(
        "SC1090",
        args[1]!,
        "question callbacks with more than one parameter or a return value",
      );
    }
    const param = cb.type.params[0];
    if (param !== undefined && param.kind !== "string" && param.kind !== "dyn") {
      lowerer.unsupported(
        "SC1090",
        args[1]!,
        `question callbacks whose parameter is not 'string' (got '${lowerer.fmt(param)}')`,
      );
    }
    const fn = query.dyn ? "rl.questionDyn" : "rl.question";
    return { kind: "libCall", fn, args: [recv, query.value, cb], type: VOID, loc };
  }
  const simple: Record<string, "rl.close" | "rl.pause" | "rl.resume" | "rl.prompt"> = {
    close: "rl.close",
    pause: "rl.pause",
    resume: "rl.resume",
    prompt: "rl.prompt",
  };
  const simpleFn = simple[name];
  if (simpleFn !== undefined && (args.length === 0 || (name === "prompt" && args.length === 1))) {
    if ((name === "pause" || name === "resume") && !ts.isExpressionStatement(call.parent)) {
      lowerer.unsupported(
        "SC1090",
        call,
        `using the result of readline ${name}() (call it as its own statement)`,
      );
    }
    // prompt(preserveCursor) keeps a terminal interface's cursor
    const flag = args[0];
    if (flag !== undefined && flag.kind !== ts.SyntaxKind.FalseKeyword) {
      if (!(lowerer.typeOf(flag).flags & ts.TypeFlags.BooleanLike)) {
        lowerer.noLowering(
          "readline prompt() with a preserveCursor that is not a boolean",
          flag,
          "pass a boolean or omit it",
        );
      }
      const recv = receiver();
      const keep = lowerer.lowerExprExpecting(flag, BOOL);
      return { kind: "libCall", fn: "rl.promptWith", args: [recv, keep], type: VOID, loc };
    }
    return { kind: "libCall", fn: simpleFn, args: [receiver()], type: VOID, loc };
  }
  if (name === "setPrompt" && args.length === 1) {
    const recv = receiver();
    const prompt = lowerPromptArg(lowerer, args[0]!);
    const fn = prompt.dyn ? "rl.setPromptDyn" : "rl.setPrompt";
    return { kind: "libCall", fn, args: [recv, prompt.value], type: VOID, loc };
  }
  if (name === "getPrompt" && args.length === 0) {
    return { kind: "libCall", fn: "rl.getPrompt", args: [receiver()], type: STRING, loc };
  }
  if (name === "getCursorPos" && args.length === 0) {
    // { rows, cols } of the prompt and the line before the cursor
    const t = lowerer.mapTypeOf(lowerer.typeOf(call));
    const shape = t?.kind === "record" ? lowerer.shapes.get(t.shapeId) : undefined;
    if (
      t?.kind !== "record" ||
      !shape ||
      !shape.fields.every((f) => (f.name === "rows" || f.name === "cols") && f.type.kind === "f64")
    ) {
      lowerer.badType(call, lowerer.typeOf(call));
    }
    const l = lowerer.declareHiddenLocal("%rl", F64);
    const recv: IrExpr = { kind: "varRef", localId: l.id, type: F64, loc };
    return {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: l.id, init: receiver(), loc }],
      result: {
        kind: "recordLit",
        fields: shape.fields.map((f) => ({
          name: f.name,
          value: {
            kind: "libCall",
            fn: "rl.cursorPos",
            args: [recv, numLit(f.name === "rows" ? 0 : 1, loc)],
            type: F64,
            loc,
          } as IrExpr,
        })),
        type: t,
        loc,
      },
      type: t,
      loc,
    };
  }
  if (name === "write" && args.length === 1 && !isNullish(args[0]!)) {
    const recv = receiver();
    const data = lowerer.lowerExprExpecting(args[0]!, STRING);
    return { kind: "libCall", fn: "rl.write", args: [recv, data], type: VOID, loc };
  }
  if (name === "write" && (args.length === 1 || args.length === 2)) {
    return lowerWriteKey(lowerer, receiver(), args[0]!, args[1], loc);
  }
  if ((name === "on" || name === "once" || name === "addListener") && args.length === 2) {
    const evT = lowerer.typeOf(args[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    const ev = event === null ? undefined : RL_EVENTS[event];
    if (ev === undefined) {
      lowerer.noLowering(
        `readline.Interface.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
        args[0]!,
        `${RL_EVENT_LIST} are the supported readline events`,
      );
    }
    // As an expression (`rl.on("line", f).on("close", g)`), the call
    // registers the listener and yields the interface, as Node's on() does.
    const recvLocal = ts.isExpressionStatement(call.parent)
      ? undefined
      : lowerer.declareHiddenLocal("%readlineListener", F64);
    const saved: IrStmt[] =
      recvLocal === undefined
        ? []
        : [{ kind: "varDecl", localId: recvLocal.id, init: receiver(), loc }];
    const recv: IrExpr =
      recvLocal === undefined
        ? receiver()
        : { kind: "varRef", localId: recvLocal.id, type: F64, loc };
    const cb = lowerer.lowerExpr(args[1]!);
    const want =
      event === "line"
        ? "string"
        : event === "error"
          ? "error"
          : event === "history"
            ? "history"
            : null;
    const param = cb.type.kind === "func" ? cb.type.params[0] : undefined;
    const paramOk =
      param === undefined ||
      (want !== null && param.kind === "dyn") ||
      (want === "string" && param.kind === "string") ||
      (want === "error" && param.kind === "object" && param.className === "Error") ||
      (want === "history" && param.kind === "array" && param.elem.kind === "string");
    if (
      cb.type.kind !== "func" ||
      cb.type.ret.kind !== "void" ||
      cb.type.params.length > (want === null ? 0 : 1) ||
      !paramOk
    ) {
      lowerer.unsupported(
        "SC1090",
        args[1]!,
        want === "string"
          ? "'line' listeners other than (input: string) => void"
          : want === "error"
            ? "'error' listeners other than (err: Error) => void"
            : want === "history"
              ? "'history' listeners other than (history: string[]) => void"
              : `'${event}' listeners with parameters or a return value (use ())`,
      );
    }
    const register: IrExpr = {
      kind: "libCall",
      fn: "rl.on",
      args: [recv, numLit(ev, loc), cb, boolLit(name === "once", loc)],
      type: VOID,
      loc,
    };
    if (recvLocal === undefined) return register;
    return {
      kind: "seqExpr",
      stmts: [...saved, { kind: "exprStmt", expr: register, loc }],
      result: { kind: "varRef", localId: recvLocal.id, type: F64, loc },
      type: F64,
      loc,
    };
  }
  lowerer.noLowering(
    `readline.Interface.${name}`,
    call,
    `question, close, pause, resume, prompt, setPrompt, getPrompt, write, for await, and on/once for ${RL_EVENT_LIST.replace(/"/g, "'")} are the supported Interface members`,
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

function isNullish(node: ts.Expression): boolean {
  return (
    node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === "undefined")
  );
}

/** write(data, key): data a string, null or undefined; key an object
 * literal of name, ctrl, meta and shift. rl.writeKey's arguments: the
 * interface, whether data is present, the data, whether the key is, whether
 * its name is, the name and the three flags. */
function lowerWriteKey(
  lowerer: Lowerer,
  recv: IrExpr,
  dataNode: ts.Expression,
  keyNode: ts.Expression | undefined,
  loc: SrcLoc,
): IrExpr {
  const empty: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
  const hasData = !isNullish(dataNode);
  const data = hasData ? lowerer.lowerExprExpecting(dataNode, STRING) : empty;
  let hasKey = false;
  let hasName = false;
  let keyName: IrExpr = empty;
  const flags: Record<string, IrExpr> = {
    ctrl: boolLit(false, loc),
    meta: boolLit(false, loc),
    shift: boolLit(false, loc),
  };
  if (keyNode !== undefined && !isNullish(keyNode)) {
    if (!ts.isObjectLiteralExpression(keyNode)) {
      lowerer.noLowering(
        "readline write() with a key that is not an object literal",
        keyNode,
        "write the key inline: write(null, { ctrl: true, name: 'u' })",
      );
    }
    hasKey = true;
    for (const p of keyNode.properties.nodes) {
      const member = ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) ? p.name.text : null;
      const value = member !== null ? (p as ts.PropertyAssignment).initializer : null;
      if (member === "name" && value !== null && !isNullish(value)) {
        hasName = true;
        keyName = lowerer.lowerExprExpecting(value, STRING);
      } else if (member === "name") {
        // an undefined name is no name
      } else if (member !== null && value !== null && flags[member] !== undefined) {
        if (!(lowerer.typeOf(value).flags & ts.TypeFlags.BooleanLike)) {
          lowerer.noLowering(`a readline write() key '${member}' that is not a boolean`, value);
        }
        flags[member] = lowerer.lowerExprExpecting(value, BOOL);
      } else {
        lowerer.noLowering(
          "readline write() with this key member",
          p,
          "name, ctrl, meta and shift are the supported key members",
        );
      }
    }
  }
  return {
    kind: "libCall",
    fn: "rl.writeKey",
    args: [
      recv,
      boolLit(hasData, loc),
      data,
      boolLit(hasKey, loc),
      boolLit(hasName, loc),
      keyName,
      flags.ctrl!,
      flags.meta!,
      flags.shift!,
    ],
    type: VOID,
    loc,
  };
}

/** readline.emitKeypressEvents(stream[, interface]): process.stdin or a
 * readable stream; the interface is a readline Interface or an object
 * literal with escapeCodeTimeout. rl.keypressStdin / rl.keypressStream
 * take the interface handle (0 for none) and the timeout (NaN: the
 * interface's, or 500). */
function lowerEmitKeypressEvents(lowerer: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  const args = expr.arguments.nodes;
  if (args.length < 1 || args.length > 2 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(`readline.emitKeypressEvents with ${args.length} arguments`, expr);
  }
  const stmts: IrStmt[] = [];
  const streamNode = args[0]!;
  let stream: IrExpr | null = null;
  const stdin =
    ts.isPropertyAccessExpression(streamNode) &&
    lowerer.stdlibGlobalMember(streamNode, "process") === "stdin";
  if (!stdin) {
    stream = lowerer.lowerExpr(streamNode);
    const info =
      stream.type.kind === "object" ? lowerer.classes.get(stream.type.className) : undefined;
    const sides = streamSidesOf(lowerer, info);
    if (sides !== "r" && sides !== "rw") {
      lowerer.noLowering(
        "readline.emitKeypressEvents with this stream",
        streamNode,
        "process.stdin and readable streams are the supported streams",
      );
    }
    const l = lowerer.declareHiddenLocal("%rlStream", stream.type);
    stmts.push({ kind: "varDecl", localId: l.id, init: stream, loc });
    stream = { kind: "varRef", localId: l.id, type: stream.type, loc };
  }
  let iface: IrExpr = numLit(0, loc);
  let timeout: IrExpr = numLit(NaN, loc);
  const ifaceNode = args[1];
  if (ifaceNode !== undefined && !isNullish(ifaceNode)) {
    if (isReadlineTyped(lowerer, ifaceNode)) {
      iface = lowerer.lowerExprExpecting(ifaceNode, F64);
    } else if (ts.isObjectLiteralExpression(ifaceNode)) {
      for (const p of ifaceNode.properties.nodes) {
        if (
          ts.isPropertyAssignment(p) &&
          ts.isIdentifier(p.name) &&
          p.name.text === "escapeCodeTimeout" &&
          lowerer.typeOf(p.initializer).flags & ts.TypeFlags.NumberLike
        ) {
          timeout = lowerer.lowerExprExpecting(p.initializer, F64);
        } else {
          lowerer.noLowering(
            "readline.emitKeypressEvents with this interface member",
            p,
            "a number escapeCodeTimeout is the supported member",
          );
        }
      }
    } else {
      lowerer.noLowering(
        "readline.emitKeypressEvents with this interface",
        ifaceNode,
        "pass a readline Interface or { escapeCodeTimeout }",
      );
    }
  }
  const call: IrExpr =
    stream === null
      ? { kind: "libCall", fn: "rl.keypressStdin", args: [iface, timeout], type: VOID, loc }
      : {
          kind: "libCall",
          fn: "rl.keypressStream",
          args: [stream, iface, timeout],
          type: VOID,
          loc,
        };
  return stmts.length === 0 ? call : { kind: "seqExpr", stmts, result: call, type: VOID, loc };
}

/** Checks a 'keypress' listener (process.stdin or a readable stream): the
 * first argument is undefined for escape sequences, so a typed first
 * parameter must admit undefined, and the key is readline.Key. */
export function checkKeypressListener(lowerer: Lowerer, node: ts.Expression, cb: IrExpr): void {
  if (cb.type.kind === "dyn") return;
  if (cb.type.kind !== "func" || cb.type.params.length > 2) {
    lowerer.noLowering(
      "'keypress' listeners with more than two parameters",
      node,
      "(str, key) => void listeners are supported",
    );
  }
  const first = cb.type.params[0];
  if (first !== undefined && first.kind !== "dyn") {
    const def = first.kind === "union" ? lowerer.unions.get(first.unionId) : undefined;
    const ok =
      !!def &&
      def.arms.some((a) => a.kind === "undefinedT") &&
      def.arms.every((a) => a.kind === "undefinedT" || a.kind === "string");
    if (!ok) {
      lowerer.noLowering(
        `a 'keypress' listener whose first parameter is '${lowerer.fmt(first)}'`,
        node,
        "the first argument is undefined for escape sequences — declare it as string | undefined",
      );
    }
  }
  const second = cb.type.params[1];
  if (second !== undefined && second.kind !== "dyn") {
    lowerer.noLowering(
      `a 'keypress' listener whose second parameter is '${lowerer.fmt(second)}'`,
      node,
      "declare the key as readline.Key",
    );
  }
}

/** process.stdin's 'keypress' listener as the checked-dynamic function the
 * runtime calls with (str, key). */
export function stdinKeypressListener(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const cb = lowerer.lowerExpr(node);
  checkKeypressListener(lowerer, node, cb);
  return lowerer.coerceToExpected(cb, DYN);
}

const CURSOR_HELPERS: Record<string, number> = {
  cursorTo: 0,
  moveCursor: 1,
  clearLine: 2,
  clearScreenDown: 3,
};

/** readline.cursorTo(stream, x[, y][, callback]), moveCursor(stream, dx,
 * dy[, callback]), clearLine(stream, dir[, callback]) and
 * clearScreenDown(stream[, callback]). The stream is process.stdout,
 * process.stderr, a writable stream, or null/undefined (nothing is
 * written and the callback runs on the next tick). The arguments are
 * evaluated in order; rl.seq checks them (NaN coordinates throw
 * ERR_INVALID_ARG_VALUE) and builds the escape sequence, which goes
 * through the stream's own write. The result is write()'s boolean, or
 * true. */
export function lowerReadlineCursorCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: string,
  loc: SrcLoc,
): IrExpr | null {
  if (member === "emitKeypressEvents") return lowerEmitKeypressEvents(lowerer, expr, loc);
  const kind = CURSOR_HELPERS[member];
  if (kind === undefined) return null;
  const args = [...expr.arguments.nodes];
  if (args.some(ts.isSpreadElement)) {
    lowerer.noLowering(`readline.${member} with a spread argument`, expr);
  }
  const numbers = kind === 0 ? 2 : kind === 1 ? 2 : kind === 2 ? 1 : 0;
  const isFunc = (n: ts.Expression): boolean =>
    lowerer.mapTypeOf(lowerer.typeOf(n))?.kind === "func";
  // cursorTo(stream, x, callback): the third argument is the callback
  let numberNodes = args.slice(1, 1 + numbers);
  let cbNode: ts.Expression | undefined = args[1 + numbers];
  if (kind === 0 && args[2] !== undefined && isFunc(args[2])) {
    numberNodes = [args[1]!];
    cbNode = args[2];
  }
  if (args.length > 2 + numbers || args.length < 1 + (kind === 0 ? 1 : numbers)) {
    lowerer.noLowering(`readline.${member} with ${args.length} arguments`, expr);
  }
  if (cbNode !== undefined && isNullish(cbNode)) cbNode = undefined;
  const stmts: IrStmt[] = [];
  const hold = (name: string, value: IrExpr): IrExpr => {
    const l = lowerer.declareHiddenLocal(name, value.type);
    stmts.push({ kind: "varDecl", localId: l.id, init: value, loc });
    return { kind: "varRef", localId: l.id, type: value.type, loc };
  };
  // the stream
  const streamNode = args[0]!;
  let target: "stdout" | "stderr" | "none" | IrExpr;
  const proc =
    ts.isPropertyAccessExpression(streamNode) && lowerer.stdlibGlobalMember(streamNode, "process");
  if (proc === "stdout" || proc === "stderr") {
    target = proc;
  } else if (isNullish(streamNode)) {
    target = "none";
  } else {
    const v = lowerer.lowerExpr(streamNode);
    const info = v.type.kind === "object" ? lowerer.classes.get(v.type.className) : undefined;
    const sides = streamSidesOf(lowerer, info);
    if (sides !== "w" && sides !== "rw") {
      lowerer.noLowering(
        `readline.${member} with this stream`,
        streamNode,
        "process.stdout, process.stderr, writable streams, null and undefined are the supported streams",
      );
    }
    target = hold("%rlStream", v);
  }
  // the coordinates (cursorTo's x may be left undefined: then nothing is
  // written, or ERR_INVALID_CURSOR_POS when y is given)
  const values: IrExpr[] = [];
  let hasB = false;
  let noX = false;
  for (let i = 0; i < numberNodes.length; i++) {
    const n = numberNodes[i]!;
    if (kind === 0 && isNullish(n)) {
      if (i === 0) {
        noX = true;
        values.push(numLit(0, loc));
      }
      continue;
    }
    if (!(lowerer.typeOf(n).flags & ts.TypeFlags.NumberLike)) {
      lowerer.noLowering(`readline.${member} with an argument that is not a number`, n);
    }
    values.push(hold("%rlArg", lowerer.lowerExprExpecting(n, F64)));
    if (i === 1) hasB = true;
  }
  // the callback: () => void, as the lib declares it
  let cb: IrExpr | null = null;
  if (cbNode !== undefined) {
    const c = lowerer.lowerExpr(cbNode);
    if (c.type.kind !== "func" || c.type.params.length > 0 || c.type.ret.kind !== "void") {
      lowerer.noLowering(
        `readline.${member} callbacks with parameters or a return value`,
        cbNode,
        "() => void callbacks are supported",
      );
    }
    cb = hold(
      "%rlCallback",
      target === "stdout" || target === "stderr" ? voidizedCallback(lowerer, c, loc) : c,
    );
  }
  const seqKind = noX && hasB && target !== "none" ? 4 : kind;
  const seq = hold("%rlSeq", {
    kind: "libCall",
    fn: "rl.seq",
    args: [
      numLit(seqKind, loc),
      values[0] ?? numLit(0, loc),
      values[1] ?? numLit(0, loc),
      boolLit(hasB, loc),
    ],
    type: STRING,
    loc,
  });
  const skipped = (): IrExpr => {
    const later: IrStmt[] = cb
      ? [
          {
            kind: "exprStmt",
            expr: { kind: "libCall", fn: "process.nextTick", args: [cb], type: VOID, loc },
            loc,
          },
        ]
      : [];
    return { kind: "seqExpr", stmts: later, result: boolLit(true, loc), type: BOOL, loc };
  };
  let result: IrExpr;
  if (target === "none" || (noX && !hasB)) {
    result = skipped();
  } else {
    let write: IrExpr;
    if (target === "stdout" || target === "stderr") {
      const utf8: IrExpr = { kind: "strLit", value: "utf8", type: STRING, loc };
      write = cb
        ? {
            kind: "libCall",
            fn: target === "stdout" ? "process.stdoutWriteBytesCb" : "process.stderrWriteBytesCb",
            args: [
              { kind: "libCall", fn: "buffer.fromStr", args: [seq, utf8], type: BYTES_U8, loc },
              utf8,
              cb,
            ],
            type: BOOL,
            loc,
          }
        : {
            kind: "libCall",
            fn: target === "stdout" ? "process.stdoutWrite" : "process.stderrWrite",
            args: [seq],
            type: BOOL,
            loc,
          };
    } else {
      write = {
        kind: "libCall",
        fn: "writable.writeStr",
        args: cb ? [target, seq, cb] : [target, seq],
        type: BOOL,
        loc,
      };
    }
    result =
      kind === 1
        ? {
            kind: "ternary",
            cond: {
              kind: "libCall",
              fn: "rl.moves",
              args: [values[0]!, values[1]!],
              type: BOOL,
              loc,
            },
            then: write,
            else_: skipped(),
            type: BOOL,
            loc,
          }
        : write;
  }
  return { kind: "seqExpr", stmts, result, type: BOOL, loc };
}

/** A checked-dynamic input or output (a JavaScript function's result, an
 * object's member, an element that may be undefined) as the stream it
 * holds: the runtime refuses a value that is not a stream with that
 * side, and answers null for an output of null or undefined. Other
 * values pass through. */
function streamFromDyn(lowerer: Lowerer, node: ts.Expression, output: boolean): IrExpr {
  let v = lowerer.lowerExpr(node);
  if (v.type.kind === "union") v = lowerer.coerceInto(node, v, DYN);
  if (v.type.kind !== "dyn") return v;
  const loc = locOf(node);
  return {
    kind: "libCall",
    fn: output ? "rl.outputFromDyn" : "rl.inputFromDyn",
    args: [v, boolLit(output, loc)],
    type: { kind: "object", className: output ? "%Writable" : "%Readable" },
    loc,
  };
}

/** The interface's input: process.stdin (null) or a readable stream. */
function lowerInput(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  if (
    ts.isPropertyAccessExpression(node) &&
    lowerer.stdlibGlobalMember(node, "process") === "stdin"
  ) {
    return null;
  }
  const v = streamFromDyn(lowerer, node, false);
  const info = v.type.kind === "object" ? lowerer.classes.get(v.type.className) : undefined;
  const sides = streamSidesOf(lowerer, info);
  if (sides !== "r" && sides !== "rw") {
    lowerer.noLowering(
      "createInterface with this input",
      node,
      "process.stdin and readable streams are the supported inputs",
    );
  }
  return v;
}

/** The interface's output: "stdout", a writable stream, or "none". */
function lowerOutput(lowerer: Lowerer, node: ts.Expression): IrExpr | "stdout" | "none" {
  if (
    ts.isPropertyAccessExpression(node) &&
    lowerer.stdlibGlobalMember(node, "process") === "stdout"
  ) {
    return "stdout";
  }
  if (node.kind === ts.SyntaxKind.NullKeyword) {
    return "none";
  }
  if (ts.isIdentifier(node) && node.text === "undefined") return "none";
  const v = streamFromDyn(lowerer, node, true);
  const info = v.type.kind === "object" ? lowerer.classes.get(v.type.className) : undefined;
  const sides = streamSidesOf(lowerer, info);
  if (sides !== "w" && sides !== "rw") {
    lowerer.noLowering(
      "createInterface with this output",
      node,
      "process.stdout and writable streams are the supported outputs",
    );
  }
  return v;
}

/** createInterface({ input, output?, terminal?, crlfDelay?, prompt?,
 * signal?, ... }) or createInterface(input, output?, completer?,
 * terminal?), from node:readline or node:readline/promises. The input is process.stdin or a readable
 * stream; the output process.stdout, a writable stream, or absent
 * (prompts are then not written). rl.create's arguments: the mode literal
 * (1 stream input, 2 stream output, 4 stdout output, 8 signal, 16
 * prompt, 32 node:readline/promises), then the input and output streams
 * when present, crlfDelay, the prompt and the signal when present. An interface that can be a
 * terminal one (a `terminal` option that is not false, or none with
 * process.stdout as the output, which is a terminal when it is a TTY)
 * goes through rl.terminal with the completer. */
export function lowerReadlineCreateCall(
  lowerer: Lowerer,
  expr: ts.CallExpression | ts.NewExpression,
  loc: SrcLoc,
  promises: boolean,
): IrExpr {
  const argNodes = expr.arguments?.nodes ?? [];
  const what = ts.isNewExpression(expr) ? "new Interface" : "createInterface";
  let input: IrExpr | null = null;
  let output: IrExpr | "stdout" | "none" = "none";
  let crlf: IrExpr = numLit(0, loc);
  let prompt: IrExpr | null = null;
  let signal: IrExpr | null = null;
  // the history and editing options (scr_rl_check_options' flags)
  let tabSize: IrExpr | null = null;
  let escapeTimeout: IrExpr | null = null;
  let historySize: IrExpr | null = null;
  let history: IrExpr | null = null;
  let removeDups: IrExpr | null = null;
  let completer: IrExpr | null = null;
  let completerValue = null as IrExpr | null; // set in setCompleter
  let completerAt = -1;
  // the terminal option: null when absent, else the boolean (a literal
  // false drops it)
  let terminal = null as IrExpr | null; // set in setTerminal
  let terminalFalse = false;
  const pre: IrStmt[] = [];
  // Only terminal interfaces call the completer. A checked-dynamic value
  // must be callable (Node's ERR_INVALID_ARG_VALUE, after the history
  // checks); a function is not checked. The slot in `pre` is filled once
  // the terminal mode is known.
  const setCompleter = (value: ts.Expression): void => {
    completerValue = lowerer.lowerExpr(value);
    completerAt = pre.length;
    pre.push({ kind: "exprStmt", expr: completerValue, loc });
  };
  const setTerminal = (value: ts.Expression): void => {
    if (isNullish(value)) return;
    if (value.kind === ts.SyntaxKind.FalseKeyword) {
      terminalFalse = true;
      return;
    }
    if (!(lowerer.typeOf(value).flags & ts.TypeFlags.BooleanLike)) {
      lowerer.noLowering(
        "the createInterface option 'terminal' with a value that is not a boolean",
        value,
      );
    }
    const local = lowerer.declareHiddenLocal("%rlTerminal", BOOL);
    pre.push({
      kind: "varDecl",
      localId: local.id,
      init: lowerer.lowerExprExpecting(value, BOOL),
      loc,
    });
    terminal = { kind: "varRef", localId: local.id, type: BOOL, loc };
  };
  const optsNode = argNodes[0];
  if (optsNode === undefined) {
    lowerer.noLowering(
      `${what} without arguments`,
      expr,
      "pass { input: process.stdin, output: process.stdout } or createInterface(input, output)",
    );
  }
  if (!ts.isObjectLiteralExpression(optsNode)) {
    // createInterface(input, output?, completer?, terminal?)
    if (argNodes.length > 4) {
      lowerer.noLowering(
        `${what} with ${argNodes.length} arguments`,
        argNodes[4]!,
        "pass createInterface(input, output, completer, terminal) or one options object",
      );
    }
    input = lowerInput(lowerer, optsNode);
    if (argNodes[1] !== undefined) output = lowerOutput(lowerer, argNodes[1]);
    const completerNode = argNodes[2];
    if (
      completerNode !== undefined &&
      !(ts.isIdentifier(completerNode) && completerNode.text === "undefined")
    ) {
      setCompleter(completerNode);
    }
    if (argNodes[3] !== undefined) setTerminal(argNodes[3]);
  } else {
    if (argNodes.length > 1) {
      lowerer.noLowering(
        `${what} with more than one argument`,
        argNodes[1]!,
        "pass every option in the one options object",
      );
    }
    let sawInput = false;
    for (const p of optsNode.properties.nodes) {
      const shorthand = ts.isShorthandPropertyAssignment(p);
      if (!(shorthand || (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)))) {
        lowerer.noLowering(
          "createInterface with this options shape",
          p,
          "spreads and computed keys have no lowering — write each member inline",
        );
      }
      const member = (p.name as ts.Identifier).text;
      // `{ input }` reads the binding of the same name
      const value: ts.Expression = shorthand
        ? (p.name as ts.Identifier)
        : (p as ts.PropertyAssignment).initializer;
      const numeric = (): IrExpr => {
        if (!(lowerer.typeOf(value).flags & ts.TypeFlags.NumberLike)) {
          lowerer.noLowering(
            `the createInterface option '${member}' with a value that is not a number`,
            value,
          );
        }
        return lowerer.lowerExprExpecting(value, F64);
      };
      if (member === "input") {
        input = lowerInput(lowerer, value);
        sawInput = true;
      } else if (member === "output") {
        output = lowerOutput(lowerer, value);
      } else if (member === "tabSize") {
        tabSize = numeric();
      } else if (member === "escapeCodeTimeout") {
        escapeTimeout = numeric();
      } else if (member === "historySize") {
        historySize = numeric();
      } else if (member === "history") {
        const h = lowerer.lowerExpr(value);
        if (h.type.kind !== "array" || h.type.elem.kind !== "string") {
          lowerer.noLowering(
            "createInterface with a history that is not a string array",
            value,
            "pass the history as a string[]",
          );
        }
        history = h;
      } else if (member === "removeHistoryDuplicates") {
        if (!(lowerer.typeOf(value).flags & ts.TypeFlags.BooleanLike)) {
          lowerer.noLowering(
            "the createInterface option 'removeHistoryDuplicates' with a value that is not a boolean",
            value,
          );
        }
        removeDups = lowerer.lowerExprExpecting(value, BOOL);
      } else if (member === "completer") {
        setCompleter(value);
      } else if (member === "terminal") {
        setTerminal(value);
      } else if (member === "crlfDelay") {
        crlf = lowerer.lowerExprExpecting(value, F64);
      } else if (member === "prompt") {
        prompt = lowerer.lowerExprExpecting(value, STRING);
      } else if (member === "signal") {
        signal = lowerer.lowerExprExpecting(value, DYN);
      } else {
        fenceOrDropOptionKey(
          lowerer,
          p,
          member,
          "createInterface",
          READLINE_DOCUMENTED_OPTIONS,
          "input, output, terminal, crlfDelay, prompt, signal, history, historySize, removeHistoryDuplicates, completer, tabSize and escapeCodeTimeout are the supported options",
        );
        // An undocumented key, dropped like Node drops it.
      }
    }
    if (!sawInput) {
      lowerer.noLowering(
        "createInterface without an input stream",
        optsNode,
        "pass { input: process.stdin, output: process.stdout }",
      );
    }
  }
  const mode =
    (input !== null ? 1 : 0) |
    (typeof output === "object" ? 2 : 0) |
    (output === "stdout" ? 4 : 0) |
    (signal !== null ? 8 : 0) |
    (prompt !== null ? 16 : 0) |
    (promises ? 32 : 0);
  const args: IrExpr[] = [numLit(mode, loc)];
  if (input !== null) args.push(input);
  if (typeof output === "object") args.push(output);
  args.push(crlf);
  if (prompt !== null) args.push(prompt);
  if (signal !== null) args.push(signal);
  const create: IrExpr = {
    kind: "libCall",
    fn: signal !== null ? "rl.createSignal" : "rl.create",
    args,
    type: F64,
    loc,
  };
  // terminal mode: 0 the option's value, 2 output.isTTY of process.stdout
  const terminalMode = terminal !== null ? 0 : !terminalFalse && output === "stdout" ? 2 : null;
  // The completer is kept as a checked-dynamic value when the interface
  // can be a terminal one; a function is otherwise only evaluated.
  let completerChecked = false;
  if (completerValue !== null && (terminalMode !== null || completerValue.type.kind !== "func")) {
    const local = lowerer.declareHiddenLocal("%rlCompleter", DYN);
    pre[completerAt] = {
      kind: "varDecl",
      localId: local.id,
      init: lowerer.coerceToExpected(completerValue, DYN),
      loc,
    };
    completer = { kind: "varRef", localId: local.id, type: DYN, loc };
    completerChecked = completerValue.type.kind !== "func";
  }
  if (
    pre.length === 0 &&
    !tabSize &&
    !escapeTimeout &&
    !historySize &&
    !history &&
    !removeDups &&
    !completer &&
    terminalMode === null
  ) {
    return create;
  }
  // The numeric options are evaluated once, checked in Node's order
  // before the interface opens, then stored on it with the history.
  const stmts: IrStmt[] = [...pre];
  const temp = (name: string, v: IrExpr | null): IrExpr => {
    if (v === null) return numLit(0, loc);
    const l = lowerer.declareHiddenLocal(name, F64);
    stmts.push({ kind: "varDecl", localId: l.id, init: v, loc });
    return { kind: "varRef", localId: l.id, type: F64, loc };
  };
  const flags = (tabSize ? 1 : 0) | (escapeTimeout ? 2 : 0) | (historySize ? 4 : 0);
  const tab = temp("%rlTabSize", tabSize);
  const esc = temp("%rlEscapeCodeTimeout", escapeTimeout);
  const size = temp("%rlHistorySize", historySize);
  if (flags !== 0) {
    stmts.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "rl.checkOptions",
        args: [numLit(flags, loc), tab, esc, size],
        type: VOID,
        loc,
      },
      loc,
    });
  }
  if (completer && completerChecked) {
    stmts.push({
      kind: "exprStmt",
      expr: { kind: "libCall", fn: "rl.checkCompleter", args: [completer], type: VOID, loc },
      loc,
    });
  }
  const id = lowerer.declareHiddenLocal("%rl", F64);
  const idRef: IrExpr = { kind: "varRef", localId: id.id, type: F64, loc };
  stmts.push({ kind: "varDecl", localId: id.id, init: create, loc });
  stmts.push({
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "rl.setOptions",
      args: [idRef, numLit(flags, loc), size, removeDups ?? boolLit(false, loc), tab, esc],
      type: VOID,
      loc,
    },
    loc,
  });
  if (history) {
    stmts.push({
      kind: "exprStmt",
      expr: { kind: "libCall", fn: "rl.setHistory", args: [idRef, history], type: VOID, loc },
      loc,
    });
  }
  if (terminalMode !== null) {
    stmts.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "rl.terminal",
        args: [
          idRef,
          numLit(terminalMode, loc),
          terminal ?? boolLit(false, loc),
          completer ?? dynUndefinedExpr(loc),
          boolLit(promises, loc),
        ],
        type: VOID,
        loc,
      },
      loc,
    });
  }
  return { kind: "seqExpr", stmts, result: idRef, type: F64, loc };
}

/** Property reads on an Interface: `history` (the history option itself,
 * or the interface's own empty array), `historySize`, `historyIndex`,
 * `crlfDelay`, `tabSize`, `escapeCodeTimeout`, `line`, `terminal` and
 * `cursor` (undefined on a non-terminal interface).
 * Null for other receivers. */
export function lowerReadlineProperty(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.questionDotToken) return null;
  if (!isReadlineTyped(lowerer, access.expression)) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(access);
  const numeric: Record<string, number> = {
    historySize: 0,
    historyIndex: 1,
    crlfDelay: 2,
    tabSize: 3,
    escapeCodeTimeout: 4,
  };
  if (name === "history") {
    const recv = lowerer.lowerExprExpecting(access.expression, F64);
    return { kind: "libCall", fn: "rl.history", args: [recv], type: arrayOf(STRING), loc };
  }
  if (numeric[name] !== undefined) {
    const recv = lowerer.lowerExprExpecting(access.expression, F64);
    return {
      kind: "libCall",
      fn: "rl.numProp",
      args: [recv, numLit(numeric[name]!, loc)],
      type: F64,
      loc,
    };
  }
  if (name === "cursor") {
    // `number | undefined`: a non-terminal interface has no cursor
    const recv = lowerer.lowerExprExpecting(access.expression, F64);
    const type: IrType = { kind: "union", unionId: lowerer.unions.intern([F64, UNDEFINED_T]) };
    const local = recv.kind === "varRef" ? null : lowerer.declareHiddenLocal("%rlCursor", F64);
    const id: IrExpr = local ? { kind: "varRef", localId: local.id, type: F64, loc } : recv;
    const result: IrExpr = {
      kind: "ternary",
      cond: { kind: "libCall", fn: "rl.isTerminal", args: [id], type: BOOL, loc },
      then: lowerer.coerceToExpected(
        { kind: "libCall", fn: "rl.cursor", args: [id], type: F64, loc },
        type,
      ),
      else_: lowerer.coerceToExpected(
        { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
        type,
      ),
      type,
      loc,
    };
    if (!local) return result;
    return {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: local.id, init: recv, loc }],
      result,
      type,
      loc,
    };
  }
  const reads: Record<string, ["rl.line" | "rl.isTerminal", IrExpr["type"]]> = {
    line: ["rl.line", STRING],
    terminal: ["rl.isTerminal", BOOL],
  };
  const read = reads[name];
  if (read !== undefined) {
    const recv = lowerer.lowerExprExpecting(access.expression, F64);
    return { kind: "libCall", fn: read[0], args: [recv], type: read[1], loc };
  }
  return null;
}
