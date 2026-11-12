import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  DYN,
  type IrExpr,
  type IrLibFn,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  VOID,
  canBoxFuncIntoDyn,
} from "../../ir/ir.js";
import { boolLit, dynUndefinedExpr, numLit, strLit, varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import { type ConsoleMethodMember } from "./builtins/console.js";
import { jsFuncNameOf, type Lowerer } from "./lowerer.js";
import {
  formatRestValue,
  formatStringConverts,
  heldFormatArgs,
  lowerConsoleInspectArg,
  lowerFormatCall,
  lowerInspectValue,
  lowerRuntimeFormat,
  runtimeFormatString,
} from "./lower-inspect.js";
import { streamSidesOf } from "./lower-stream.js";

/** node:console Console instances: a native handle (the checked-dynamic
 * representation the stdlib Console type maps to) over two output
 * targets — process.stdout/process.stderr, or writable streams — plus
 * the ignoreErrors flag. The log/info/debug (stdout) and error/warn
 * (stderr) members lower through util.format into ONE write of the
 * formatted line, exactly Node's kWriteToConsole; the remaining Console
 * surface stays fenced like the global console's. */

const OPTION_KEYS = new Set(["stdout", "stderr", "ignoreErrors", "groupIndentation"]);

function isConsoleCtor(lowerer: Lowerer, callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) {
    const bi = lowerer.builtinImportOf(callee);
    return bi?.module === "console" && bi.member === "Console";
  }
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "Console") return false;
  return (
    lowerer.isStdlibGlobal(callee.expression, "console") ||
    lowerer.builtinNamespaceModuleOf(callee.expression) === "console"
  );
}

function isUndefinedArg(node: ts.Expression | undefined): boolean {
  return (
    node === undefined ||
    (ts.isIdentifier(node) && node.text === "undefined") ||
    ts.isVoidExpression(node)
  );
}

type Target = { fd: number } | { local: string; type: IrType };

type OptionRole = "stdout" | "stderr" | "ignoreErrors" | "groupIndentation";

/** `new Console(stdout[, stderr][, ignoreErrors])` and
 * `new Console({ stdout, stderr, ignoreErrors, groupIndentation })`.
 * Arguments and option initializers evaluate in source order into hidden
 * locals before the handle exists (Node evaluates them before the
 * constructor body); an absent stderr shares stdout's target. The group
 * indentation is validated by the runtime like Node's validateInteger
 * (colorMode and inspectOptions stay refused: the inspect color and option
 * surfaces have no lowering). */
export function lowerConsoleNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (!isConsoleCtor(lowerer, expr.expression)) return null;
  const loc = locOf(expr);
  const args = expr.arguments?.nodes ?? [];
  const entries: { role: OptionRole; node: ts.Expression | undefined }[] = [];
  const first = args[0];
  if (first && ts.isObjectLiteralExpression(first)) {
    for (const prop of first.properties.nodes) {
      let name: string | null = null;
      let value: ts.Expression | null = null;
      if (
        ts.isPropertyAssignment(prop) &&
        (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
      ) {
        name = (prop.name as ts.Identifier | ts.StringLiteral).text;
        value = prop.initializer;
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        name = (prop.name as ts.Identifier).text;
        value = prop.name as ts.Identifier;
      }
      if (name === null || value === null || !OPTION_KEYS.has(name)) {
        lowerer.noLowering(
          "Console options other than stdout, stderr, ignoreErrors, and groupIndentation",
          prop,
          "colorMode and inspectOptions have no lowering yet",
        );
      }
      entries.push({ role: name as OptionRole, node: value });
    }
  } else {
    entries.push({ role: "stdout", node: args[0] });
    entries.push({ role: "stderr", node: args[1] });
    entries.push({ role: "ignoreErrors", node: args[2] });
  }
  const stmts: IrStmt[] = [];
  const target = (node: ts.Expression, role: string): Target => {
    if (ts.isPropertyAccessExpression(node)) {
      const member = lowerer.stdlibGlobalMember(node, "process");
      if (member === "stdout") return { fd: 1 };
      if (member === "stderr") return { fd: 2 };
    }
    const value = lowerer.lowerExpr(node);
    const info =
      value.type.kind === "object" ? lowerer.classes.get(value.type.className) : undefined;
    const sides = streamSidesOf(lowerer, info);
    if (sides !== "w" && sides !== "rw") {
      lowerer.noLowering(
        `a Console ${role} of type '${lowerer.fmt(value.type)}'`,
        node,
        "process.stdout, process.stderr, and node:stream writables (Writable, Duplex, Transform, PassThrough, and their subclasses) are the supported Console streams",
      );
    }
    const local = lowerer.declareHiddenLocal(`%console${role}`, value.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: value, loc });
    return { local: local.id, type: value.type };
  };
  let out: Target | null = null;
  let err: Target | null = null;
  let ignore: IrExpr | null = null;
  let group: IrExpr | null = null;
  for (const entry of entries) {
    const node = entry.node;
    if (isUndefinedArg(node)) {
      // `void expr` still evaluates its operand.
      if (node !== undefined && ts.isVoidExpression(node)) {
        stmts.push({ kind: "exprStmt", expr: lowerer.lowerExpr(node), loc });
      }
      if (entry.role === "stdout") out = null;
      else if (entry.role === "stderr") err = null;
      else if (entry.role === "ignoreErrors") ignore = null;
      else group = null;
      continue;
    }
    if (entry.role === "stdout") {
      out = target(node!, "stdout");
    } else if (entry.role === "stderr") {
      err = target(node!, "stderr");
    } else if (entry.role === "ignoreErrors") {
      const value = lowerer.lowerExpr(node!);
      if (value.type.kind !== "bool") {
        lowerer.noLowering(
          `ignoreErrors of type '${lowerer.fmt(value.type)}'`,
          node!,
          "pass a boolean",
        );
      }
      const local = lowerer.declareHiddenLocal("%consoleIgnoreErrors", BOOL);
      stmts.push({ kind: "varDecl", localId: local.id, init: value, loc });
      ignore = varRef(local.id, BOOL, loc);
    } else {
      const value = lowerer.lowerExpr(node!);
      if (value.type.kind !== "f64") {
        lowerer.noLowering(
          `groupIndentation of type '${lowerer.fmt(value.type)}'`,
          node!,
          "Node requires a number (an integer from 0 to 1000)",
        );
      }
      const local = lowerer.declareHiddenLocal("%consoleGroupIndentation", value.type);
      stmts.push({ kind: "varDecl", localId: local.id, init: value, loc });
      group = varRef(local.id, value.type, loc);
    }
  }
  if (out === null) {
    return lowerer.noLowering(
      "new Console without a stdout stream",
      expr,
      "pass the stdout stream",
    );
  }
  const stdoutTarget: Target = out;
  const stderrTarget: Target = err ?? stdoutTarget;
  const handle = lowerer.declareHiddenLocal("%console", DYN);
  const fdOf = (t: Target): IrExpr => numLit("fd" in t ? t.fd : 0, loc);
  stmts.push({
    kind: "varDecl",
    localId: handle.id,
    init: {
      kind: "libCall",
      fn: "console.new",
      args: [
        fdOf(stdoutTarget),
        fdOf(stderrTarget),
        ignore ?? boolLit(true, loc),
        group ?? numLit(2, loc),
      ],
      type: DYN,
      loc,
    },
    loc,
  });
  const targets: Target[] = [stdoutTarget, stderrTarget];
  for (let which = 0; which < targets.length; which++) {
    const t = targets[which]!;
    if (!("local" in t)) continue;
    stmts.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "console.bind",
        args: [varRef(handle.id, DYN, loc), numLit(which, loc), varRef(t.local, t.type, loc)],
        type: VOID,
        loc,
      },
      loc,
    });
  }
  return { kind: "seqExpr", stmts, result: varRef(handle.id, DYN, loc), type: DYN, loc };
}

/** `c.<member>(...)` on a stdlib-Console-typed receiver that is not the
 * global console object (that path keeps its direct lowering): the receiver
 * evaluates first, then the arguments, then the member — Node's own
 * Console.prototype methods, over the instance's counters, timers, and group
 * indentation (the runtime resolves the global console's handle to its
 * thread-local state and uses each instance's own otherwise). The output
 * members render util.format's one string and write it through
 * kWriteToConsole's indentation; the rest print through the same writer. */
export function lowerConsoleInstanceCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr | null {
  if (call.questionDotToken || !ts.isPropertyAccessExpression(call.expression)) return null;
  const access = call.expression;
  if (access.questionDotToken) return null;
  const recvType = lowerer.typeOf(access.expression);
  const sym = recvType.getAliasSymbol() ?? recvType.getSymbol();
  if (!sym || ts.symbolName(sym) !== "Console" || !lowerer.isStdlibSymbol(sym)) return null;
  const member = access.name.text;
  const args = call.arguments.nodes;
  const receiver = lowerer.lowerExpr(access.expression);
  if (receiver.type.kind !== "dyn") return null;
  const stmts: IrStmt[] = [];
  // The receiver's own evaluation, before any argument (Node evaluates the
  // callee's receiver first).
  const inst = hoist(lowerer, stmts, "%consoleInst", receiver, loc);
  const write = (text: IrExpr, toStderr: boolean): IrExpr => ({
    kind: "libCall",
    fn: "console.write",
    args: [inst, text, boolLit(toStderr, loc)],
    type: VOID,
    loc,
  });
  const memberCall = (fn: IrLibFn, extra: IrExpr[], type: IrType): IrExpr => ({
    kind: "libCall",
    fn,
    args: [inst, ...extra],
    type,
    loc,
  });
  const done = (result: IrExpr): IrExpr => seq(stmts, result, loc);
  switch (member) {
    case "log":
    case "info":
    case "debug":
    case "dirxml":
      return done(write(lowerConsoleText(lowerer, call, "console.log", loc), false));
    case "error":
    case "warn":
      return done(write(lowerConsoleText(lowerer, call, "console.error", loc), true));
    case "trace":
      // The stderr line "Trace[: args]" and the captured frames, scriptc's
      // own frame text (SEMANTICS divergence 11) — as console.trace.
      return done(
        memberCall(
          "console.instTrace",
          [lowerConsoleText(lowerer, call, "console.trace", loc)],
          VOID,
        ),
      );
    case "group":
    case "groupCollapsed": {
      // The label line prints BEFORE the indentation grows.
      if (args.length > 0) {
        const text = lowerConsoleText(lowerer, call, `console.${member}`, loc);
        stmts.push({ kind: "exprStmt", expr: write(text, false), loc });
      }
      return done(memberCall("console.instGroup", [numLit(1, loc)], VOID));
    }
    case "groupEnd":
      evaluateIgnored(lowerer, args, stmts, loc);
      return done(memberCall("console.instGroup", [numLit(-1, loc)], VOID));
    case "count": {
      const raw = rawLabel(lowerer, member, args[0]);
      const rawRef = raw === null ? null : hoist(lowerer, stmts, "%consoleLabel", raw, loc);
      evaluateIgnored(lowerer, args.slice(1), stmts, loc);
      return done(memberCall("console.instCount", [labelText(rawRef, loc)], VOID));
    }
    case "countReset": {
      const raw = rawLabel(lowerer, member, args[0]);
      const rawRef = raw === null ? null : hoist(lowerer, stmts, "%consoleLabel", raw, loc);
      evaluateIgnored(lowerer, args.slice(1), stmts, loc);
      // Node looks the RAW label up (`counts.has(label)`): only string
      // labels (and the default) ever reset.
      const boxed: IrExpr =
        rawRef === null
          ? dynUndefinedExpr(loc)
          : rawRef.type.kind === "dyn"
            ? rawRef
            : { kind: "dynFrom", value: rawRef, type: DYN, loc };
      return done(emitWarning(memberCall("console.instCountReset", [boxed], STRING), loc));
    }
    case "time": {
      const raw = rawLabel(lowerer, member, args[0]);
      const rawRef = raw === null ? null : hoist(lowerer, stmts, "%consoleLabel", raw, loc);
      evaluateIgnored(lowerer, args.slice(1), stmts, loc);
      return done(
        emitWarning(memberCall("console.instTime", [labelText(rawRef, loc)], STRING), loc),
      );
    }
    case "timeEnd":
    case "timeLog":
      return lowerConsoleInstTimeLog(lowerer, call, inst, member, loc, stmts, done);
    case "assert":
      return lowerConsoleInstAssert(lowerer, call, write, loc, stmts, done);
    case "dir": {
      const [valueNode, optionsNode, ...rest] = args;
      const rendered =
        valueNode === undefined
          ? strLit("undefined", loc)
          : lowerInspectValue(lowerer, valueNode, optionsNode, loc, true);
      if (rest.length === 0) return done(write(rendered, false));
      const text = hoist(lowerer, stmts, "%consoleDir", rendered, loc);
      evaluateIgnored(lowerer, rest, stmts, loc);
      return done(write(text, false));
    }
    case "table":
      return done(lowerConsoleTable(lowerer, call, loc, inst));
    case "clear":
      evaluateIgnored(lowerer, args, stmts, loc);
      return done(memberCall("console.instClear", [], VOID));
  }
  return lowerer.noLowering(
    `Console.${member}`,
    call,
    "log, info, debug, error, warn, dir, dirxml, trace, assert, count, countReset, time, timeEnd, timeLog, group, groupCollapsed, groupEnd, table, and clear are the lowered Console members",
  );
}

/** util.format's one string for a Console method's arguments (the instance
 * path: kWriteToConsole receives formatWithOptions' output, not the
 * ScrLogArg protocol the global intrinsics take). Literal format strings and
 * run-time format strings follow lowerConsoleOutput; everything else is the
 * space-joined rest-arg rendering. */
function lowerConsoleText(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  surface: string,
  loc: SrcLoc,
): IrExpr {
  const nodes = expr.arguments.nodes;
  const first = nodes[0];
  const pair = (node: ts.Expression, value: IrExpr) => ({ node, value });
  const join = (parts: { node: ts.Expression; value: IrExpr }[]): IrExpr => {
    if (parts.length === 0) return strLit("", loc);
    const pieces: IrExpr[] = [];
    parts.forEach(({ node, value }, i) => {
      if (i > 0) pieces.push(strLit(" ", loc));
      pieces.push(formatRestValue(lowerer, node, value, loc));
    });
    return concat(pieces, loc);
  };
  if (nodes.length > 1 && isStringLiteralLike(first) && hasFormatSpecifier(first.text))
    return lowerFormatCall(lowerer, expr, loc, false);
  if (nodes.some(ts.isSpreadElement)) return lowerRuntimeFormat(lowerer, nodes, loc);
  const runtime =
    nodes.length > 1 && !isStringLiteralLike(first) ? runtimeFormatString(lowerer, first!) : null;
  if (runtime === "other" && !formatStringConverts(lowerer, first!))
    return lowerRuntimeFormat(lowerer, nodes, loc);
  if (runtime !== null) {
    const held = heldFormatArgs(lowerer, nodes, loc);
    if (!held.joinable) return seq(held.stmts, held.format(), loc);
    const joined = join(held.args.map((arg) => pair(arg.node, arg.ref())));
    return seq(
      held.stmts,
      {
        kind: "ternary",
        cond: held.specifies,
        then: held.format(),
        else_: joined,
        type: STRING,
        loc,
      },
      loc,
    );
  }
  return join(nodes.map((node) => pair(node, lowerer.lowerExpr(node))));
}

/** A Console instance's timeEnd/timeLog: the label's elapsed time, Node's
 * `${label}: ${formatTime(ms)}` line (timeLog appends its data as log
 * appends arguments after a format string), or the "No such label"
 * warning. Every argument evaluates before the timer is read. */
function lowerConsoleInstTimeLog(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  inst: IrExpr,
  member: "timeEnd" | "timeLog",
  loc: SrcLoc,
  stmts: IrStmt[],
  done: (result: IrExpr) => IrExpr,
): IrExpr {
  const raw = rawLabel(lowerer, member, expr.arguments.nodes[0]);
  const rawRef = raw === null ? null : hoist(lowerer, stmts, "%consoleLabel", raw, loc);
  const data = expr.arguments.nodes.slice(1);
  const dataRefs: { node: ts.Expression; value: IrExpr }[] = [];
  if (member === "timeLog") {
    for (const node of data)
      dataRefs.push({
        node,
        value: hoist(lowerer, stmts, "%consoleData", lowerer.lowerExpr(node), loc),
      });
  } else {
    evaluateIgnored(lowerer, data, stmts, loc);
  }
  const label = hoist(lowerer, stmts, "%consoleLabelText", labelText(rawRef, loc), loc);
  const elapsed = hoist(
    lowerer,
    stmts,
    "%consoleElapsed",
    {
      kind: "libCall",
      fn: member === "timeEnd" ? "console.instTimeEnd" : "console.instTimeLog",
      args: [inst, label],
      type: STRING,
      loc,
    },
    loc,
  );
  const parts: IrExpr[] = [label, strLit(": ", loc), elapsed];
  for (const { node, value } of dataRefs) {
    parts.push(strLit(" ", loc));
    parts.push(formatRestValue(lowerer, node, value, loc));
  }
  const line = concat(parts, loc);
  const missing: IrExpr = {
    kind: "strEq",
    negated: false,
    left: elapsed,
    right: strLit("", loc),
    type: BOOL,
    loc,
  };
  stmts.push({
    kind: "if",
    cond: { kind: "unary", op: "!", operand: missing, type: BOOL, loc },
    then: [
      {
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "console.write",
          args: [inst, line, boolLit(false, loc)],
          type: VOID,
          loc,
        },
        loc,
      },
    ],
    else_: null,
    loc,
  });
  const warning: IrExpr = {
    kind: "ternary",
    cond: missing,
    then: concat(
      [strLit("No such label '", loc), label, strLit(`' for console.${member}()`, loc)],
      loc,
    ),
    else_: strLit("", loc),
    type: STRING,
    loc,
  };
  return done(emitWarning(warning, loc));
}

/** A Console instance's assert: the same prefix rules as the global one,
 * printed through the instance's warn (stderr) writer. */
function lowerConsoleInstAssert(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  write: (text: IrExpr, toStderr: boolean) => IrExpr,
  loc: SrcLoc,
  stmts: IrStmt[],
  done: (result: IrExpr) => IrExpr,
): IrExpr {
  const [valueNode, ...args] = expr.arguments.nodes;
  const ok =
    valueNode === undefined
      ? boolLit(false, loc)
      : hoist(lowerer, stmts, "%consoleAssert", lowerer.lowerCondition(valueNode), loc);
  const first = args[0];
  let failed: IrExpr;
  if (isStringLiteralLike(first) && args.length > 1 && hasFormatSpecifier(first.text)) {
    // The format path lowers its arguments inside the failing branch; that
    // is only exact when skipping their evaluation is unobservable.
    const effectful = args.find((a) => !isPureArgument(a));
    if (effectful !== undefined) {
      lowerer.noLowering(
        "console.assert with a format string and computed arguments",
        effectful,
        "evaluate the argument first (const v = ...) and pass the binding",
      );
    }
    failed = write(lowerFormatCall(lowerer, expr, loc, false, args, "Assertion failed: "), true);
  } else {
    const values = args.map((node) => ({
      node,
      value: hoist(lowerer, stmts, "%consoleData", lowerer.lowerExpr(node), loc),
    }));
    const head = values[0];
    const parts: IrExpr[] = [];
    if (head !== undefined && head.value.type.kind === "string") {
      if (values.length > 1 && !isStringLiteralLike(head.node)) {
        lowerer.noLowering(
          "console.assert with a runtime format string and further arguments",
          head.node,
          "the %-substitution positions are runtime-dependent — use a string literal",
        );
      }
      parts.push(strLit("Assertion failed: ", loc), head.value);
      for (const v of values.slice(1)) {
        parts.push(strLit(" ", loc), formatRestValue(lowerer, v.node, v.value, loc));
      }
    } else {
      if (head !== undefined && head.value.type.kind !== "dyn") {
        const t = head.value.type;
        if (t.kind === "union") {
          const def = lowerer.unions.get(t.unionId);
          if (def?.arms.some((arm) => arm.kind === "string")) {
            lowerer.noLowering(
              "console.assert with a first message argument that may be a string",
              head.node,
              "Node prefixes string messages and inserts a separate prefix otherwise — narrow the message type",
            );
          }
        }
      }
      if (head !== undefined && head.value.type.kind === "dyn") {
        lowerer.noLowering(
          "console.assert with an untyped first message argument",
          head.node,
          "Node prefixes string messages and inserts a separate prefix otherwise — narrow the message type",
        );
      }
      parts.push(strLit("Assertion failed", loc));
      for (const v of values) {
        parts.push(strLit(" ", loc), formatRestValue(lowerer, v.node, v.value, loc));
      }
    }
    failed = write(concat(parts, loc), true);
  }
  stmts.push({
    kind: "if",
    cond: { kind: "unary", op: "!", operand: ok, type: BOOL, loc },
    then: [{ kind: "exprStmt", expr: failed, loc }],
    else_: null,
    loc,
  });
  return done(noop(loc));
}

/* ── the global console's output members ─────────────────────────────── */

/** One console argument, already lowered, in the shape the console
 * intrinsics take: Node's formatter (formatWithOptions) prints strings
 * verbatim, numbers and booleans directly, and everything else through
 * util.inspect at the rest-args depth 2. */
export function lowerConsoleArg(
  lowerer: Lowerer,
  node: ts.Expression,
  lowered: IrExpr,
  surface: string,
  loc: SrcLoc,
): IrExpr {
  // Checked-dynamic values carry their own shape, so the runtime
  // renders them exactly like Node's console formatter renders a
  // non-format argument: strings VERBATIM, everything else through
  // inspect at the rest-args depth 2 (formatWithOptions) — scalar
  // kinds byte-exactly, boxed functions as [Function: name] /
  // [Function (anonymous)], composites through the dyn walk
  // (insp.dyn). A value the inspector does not render throws the
  // 'not supported yet' Error before anything is written.
  if (lowered.type.kind === "dyn") {
    return {
      kind: "libCall",
      fn: "insp.dynS",
      args: [lowered, numLit(2, loc)],
      type: STRING,
      loc,
    };
  }
  // A function VALUE prints Node's [Function: name] form by boxing
  // across the checked-dynamic boundary and rendering through the same
  // dyn arm. The box carries the name of the definition the argument
  // reaches; any other argument (a parameter, a member) is named by the
  // function it holds, at run time.
  if (
    lowered.type.kind === "func" &&
    canBoxFuncIntoDyn(
      lowered.type,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  ) {
    const name = jsFuncNameOf(node, lowerer);
    const boxed: IrExpr = {
      kind: "dynFrom",
      value: lowered,
      type: DYN,
      ...(name !== null ? { fnName: name } : {}),
      loc,
    };
    return {
      kind: "libCall",
      fn: "insp.dynS",
      args: [boxed, numLit(2, loc)],
      type: STRING,
      loc,
    };
  }
  // number/string/boolean ride the ScrLogArg protocol directly (the
  // runtime formats them Node-exactly — including -0).
  if (
    lowered.type.kind === "f64" ||
    lowered.type.kind === "string" ||
    lowered.type.kind === "bool"
  ) {
    return lowered;
  }
  // Everything else renders through the static inspect machinery at
  // the rest-args depth 2 (formatWithOptions): arrays, records,
  // unions (a string arm prints VERBATIM — the console.log vs
  // inspect distinction, per arm), Maps/Sets, plain undefined/null,
  // regexes, symbols, error values, Buffers. Shapes inspect cannot
  // render fence honestly with the reason.
  return lowerConsoleInspectArg(
    lowerer,
    node,
    lowerer.deferredFieldSlot(lowered) ?? lowered,
    surface,
    loc,
  );
}

function consoleWrite(stdout: boolean, args: IrExpr[], loc: SrcLoc): IrExpr {
  return {
    kind: "intrinsic",
    name: stdout ? "console.log" : "console.error",
    args,
    type: VOID,
    loc,
  };
}

function hasFormatSpecifier(text: string): boolean {
  return /%[sdifjoOc%]/.test(text);
}

function isStringLiteralLike(
  node: ts.Expression | undefined,
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return (
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
  );
}

/** console.log/info/debug (stdout) and console.error/warn (stderr), and
 * the members Node defines as log (dirxml, group's label line): one
 * formatted line through the console intrinsic. */
export function lowerConsoleOutput(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  stdout: boolean,
  surface: string,
  loc: SrcLoc,
  intrinsic: "console.log" | "console.error" | "console.trace" = stdout
    ? "console.log"
    : "console.error",
): IrExpr {
  /** One write of the formatted line: the console.log/error intrinsic, or
   * console.trace for trace's stderr line. */
  const emitLine = (args: IrExpr[]): IrExpr => ({
    kind: "intrinsic",
    name: intrinsic,
    args,
    type: VOID,
    loc,
  });
  // A LITERAL format string with %-specifiers and further arguments
  // (`console.log('Mismatched %s function calls. Expected %s, actual
  // %d.', name, seg, n)` — test/common's exit report): Node's console
  // formatter IS util.format — route through the format lowering and
  // print its one string. Specifier-free first strings keep the
  // plain space-joined path below (identical output, cheaper).
  const first = expr.arguments.nodes[0];
  if (
    expr.arguments.nodes.length > 1 &&
    isStringLiteralLike(first) &&
    hasFormatSpecifier(first.text)
  ) {
    return emitLine([lowerFormatCall(lowerer, expr, loc, false)]);
  }
  const nodes = expr.arguments.nodes;
  // Spread arguments and format strings that may hold a substitution at
  // run time go through the runtime formatter. A string first argument
  // without a '%' keeps the space-joined write below.
  if (nodes.some(ts.isSpreadElement)) return emitLine([lowerRuntimeFormat(lowerer, nodes, loc)]);
  const runtime =
    nodes.length > 1 && !isStringLiteralLike(first) ? runtimeFormatString(lowerer, first!) : null;
  if (runtime === "other" && !formatStringConverts(lowerer, first!))
    return emitLine([lowerRuntimeFormat(lowerer, nodes, loc)]);
  if (runtime !== null) {
    const held = heldFormatArgs(lowerer, nodes, loc);
    if (!held.joinable) return seq(held.stmts, emitLine([held.format()]), loc);
    const joined = held.args.map((arg) =>
      lowerConsoleArg(lowerer, arg.node, arg.ref(), surface, loc),
    );
    const write: IrStmt = {
      kind: "if",
      cond: held.specifies,
      then: [{ kind: "exprStmt", expr: emitLine([held.format()]), loc }],
      else_: [{ kind: "exprStmt", expr: emitLine(joined), loc }],
      loc,
    };
    return seq([...held.stmts, write], noop(loc), loc);
  }
  const args = nodes.map((a) => lowerConsoleArg(lowerer, a, lowerer.lowerExpr(a), surface, loc));
  return emitLine(args);
}

/* ── the rest of the global console ──────────────────────────────────── */

function isUndefinedLiteral(node: ts.Expression): boolean {
  return ts.isIdentifier(node) && node.text === "undefined";
}

/** Literals and identifier reads: evaluating one later, or not at all,
 * is unobservable. */
function isPureArgument(node: ts.Expression): boolean {
  return (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

/** Evaluate `value` into a fresh hidden local (Node evaluates every call
 * argument before the method body runs) and answer a read of it. Unit
 * values have no local: their effects run here and a literal stands in;
 * void values pass through for the consumer's fence. */
function hoist(
  lowerer: Lowerer,
  stmts: IrStmt[],
  name: string,
  value: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const k = value.type.kind;
  if (k === "void") return value;
  if (k === "undefinedT" || k === "nullT") {
    if (value.kind !== "unitLit") stmts.push({ kind: "exprStmt", expr: value, loc });
    return { kind: "unitLit", unit: k === "nullT" ? "null" : "undefined", type: value.type, loc };
  }
  const local = lowerer.declareHiddenLocal(name, value.type);
  stmts.push({ kind: "varDecl", localId: local.id, init: value, loc });
  return varRef(local.id, value.type, loc);
}

function seq(stmts: IrStmt[], result: IrExpr, loc: SrcLoc): IrExpr {
  return stmts.length === 0 ? result : { kind: "seqExpr", stmts, result, type: result.type, loc };
}

/** The tail of a lowering whose effects all sit in its statements. */
function noop(loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn: "console.noop", args: [], type: VOID, loc };
}

/** Arguments Node ignores still evaluate, in order. */
function evaluateIgnored(
  lowerer: Lowerer,
  args: readonly ts.Expression[],
  stmts: IrStmt[],
  loc: SrcLoc,
): void {
  for (const arg of args) {
    const value = lowerer.lowerExpr(arg);
    if (value.kind !== "unitLit") stmts.push({ kind: "exprStmt", expr: value, loc });
  }
}

/** A label argument's value before coercion (`label = 'default'`):
 * null when absent or the literal undefined. */
function rawLabel(
  lowerer: Lowerer,
  member: string,
  node: ts.Expression | undefined,
): IrExpr | null {
  if (node === undefined || isUndefinedLiteral(node)) return null;
  const value = lowerer.lowerExpr(node);
  const t = value.type;
  if (t.kind === "string" || t.kind === "dyn" || lowerer.dynConvertible(t)) {
    if (t.kind !== "func" && t.kind !== "bytes") return value;
  }
  return lowerer.noLowering(
    `console.${member} with a '${lowerer.fmt(t)}' label`,
    node,
    "labels are strings, numbers, booleans, null, or undefined",
  );
}

/** Node's `${label}` over the defaulted label. */
function labelText(raw: IrExpr | null, loc: SrcLoc): IrExpr {
  if (raw === null) return strLit("default", loc);
  if (raw.type.kind === "string") return raw;
  const boxed: IrExpr =
    raw.type.kind === "dyn" ? raw : { kind: "dynFrom", value: raw, type: DYN, loc };
  return { kind: "libCall", fn: "console.label", args: [boxed], type: STRING, loc };
}

/** process.emitWarning(message) with Node's default type; an empty
 * message (the runtime's "no warning applies" answer) emits nothing. */
function emitWarning(message: IrExpr, loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn: "process.emitWarningText", args: [message], type: VOID, loc };
}

function concat(parts: IrExpr[], loc: SrcLoc): IrExpr {
  return parts.reduce((left, right) => ({
    kind: "strConcat",
    left,
    right,
    type: STRING,
    loc,
  }));
}

/** console.timeEnd/timeLog: the label's elapsed time, Node's
 * `${label}: ${formatTime(ms)}` line (timeLog appends its data the way
 * log appends arguments after a format string), or the "No such label"
 * warning. Every argument evaluates before the timer is read. */
function lowerConsoleTimeLog(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: "timeEnd" | "timeLog",
  loc: SrcLoc,
): IrExpr {
  const stmts: IrStmt[] = [];
  const raw = rawLabel(lowerer, member, expr.arguments.nodes[0]);
  const rawRef = raw === null ? null : hoist(lowerer, stmts, "%consoleLabel", raw, loc);
  const data = expr.arguments.nodes.slice(1);
  const dataRefs: { node: ts.Expression; value: IrExpr }[] = [];
  if (member === "timeLog") {
    for (const node of data) {
      dataRefs.push({
        node,
        value: hoist(lowerer, stmts, "%consoleData", lowerer.lowerExpr(node), loc),
      });
    }
  } else {
    evaluateIgnored(lowerer, data, stmts, loc);
  }
  const label = hoist(lowerer, stmts, "%consoleLabelText", labelText(rawRef, loc), loc);
  const elapsed = hoist(
    lowerer,
    stmts,
    "%consoleElapsed",
    {
      kind: "libCall",
      fn: member === "timeEnd" ? "console.timeEnd" : "console.timeLog",
      args: [label],
      type: STRING,
      loc,
    },
    loc,
  );
  const line = concat([label, strLit(": ", loc), elapsed], loc);
  const rendered = dataRefs.map(({ node, value }) =>
    lowerConsoleArg(lowerer, node, value, `console.${member}`, loc),
  );
  const missing: IrExpr = {
    kind: "strEq",
    negated: false,
    left: elapsed,
    right: strLit("", loc),
    type: BOOL,
    loc,
  };
  stmts.push({
    kind: "if",
    cond: { kind: "unary", op: "!", operand: missing, type: BOOL, loc },
    then: [{ kind: "exprStmt", expr: consoleWrite(true, [line, ...rendered], loc), loc }],
    else_: null,
    loc,
  });
  const warning: IrExpr = {
    kind: "ternary",
    cond: missing,
    then: concat(
      [strLit("No such label '", loc), label, strLit(`' for console.${member}()`, loc)],
      loc,
    ),
    else_: strLit("", loc),
    type: STRING,
    loc,
  };
  return seq(stmts, emitWarning(warning, loc), loc);
}

/** console.assert(value, ...message): on a falsy value, Node prefixes a
 * string first argument with "Assertion failed: " (or inserts
 * "Assertion failed" before a non-string one) and prints through warn —
 * so a format string still formats. */
function lowerConsoleAssert(lowerer: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  const stmts: IrStmt[] = [];
  const [valueNode, ...args] = expr.arguments.nodes;
  const ok =
    valueNode === undefined
      ? boolLit(false, loc)
      : hoist(lowerer, stmts, "%consoleAssert", lowerer.lowerCondition(valueNode), loc);
  const first = args[0];
  let failed: IrExpr;
  if (isStringLiteralLike(first) && args.length > 1 && hasFormatSpecifier(first.text)) {
    // The format path lowers its arguments inside the failing branch;
    // that is only exact when skipping their evaluation is unobservable.
    const effectful = args.find((a) => !isPureArgument(a));
    if (effectful !== undefined) {
      lowerer.noLowering(
        "console.assert with a format string and computed arguments",
        effectful,
        "evaluate the argument first (const v = ...) and pass the binding",
      );
    }
    failed = consoleWrite(
      false,
      [lowerFormatCall(lowerer, expr, loc, false, args, "Assertion failed: ")],
      loc,
    );
  } else {
    const values = args.map((node) => ({
      node,
      value: hoist(lowerer, stmts, "%consoleData", lowerer.lowerExpr(node), loc),
    }));
    const head = values[0];
    let rendered: IrExpr[];
    if (head !== undefined && head.value.type.kind === "string") {
      if (values.length > 1 && !isStringLiteralLike(head.node)) {
        lowerer.noLowering(
          "console.assert with a runtime format string and further arguments",
          head.node,
          "the %-substitution positions are runtime-dependent — use a string literal",
        );
      }
      rendered = [
        concat([strLit("Assertion failed: ", loc), head.value], loc),
        ...values
          .slice(1)
          .map(({ node, value }) => lowerConsoleArg(lowerer, node, value, "console.assert", loc)),
      ];
    } else {
      if (head !== undefined && head.value.type.kind !== "dyn") {
        const t = head.value.type;
        if (t.kind === "union") {
          const def = lowerer.unions.get(t.unionId);
          if (def?.arms.some((arm) => arm.kind === "string")) {
            lowerer.noLowering(
              "console.assert with a first message argument that may be a string",
              head.node,
              "Node prefixes string messages and inserts a separate prefix otherwise — narrow the message type",
            );
          }
        }
      }
      if (head !== undefined && head.value.type.kind === "dyn") {
        lowerer.noLowering(
          "console.assert with an untyped first message argument",
          head.node,
          "Node prefixes string messages and inserts a separate prefix otherwise — narrow the message type",
        );
      }
      rendered = [
        strLit("Assertion failed", loc),
        ...values.map(({ node, value }) =>
          lowerConsoleArg(lowerer, node, value, "console.assert", loc),
        ),
      ];
    }
    failed = consoleWrite(false, rendered, loc);
  }
  stmts.push({
    kind: "if",
    cond: { kind: "unary", op: "!", operand: ok, type: BOOL, loc },
    then: [{ kind: "exprStmt", expr: failed, loc }],
    else_: null,
    loc,
  });
  return seq(stmts, noop(loc), loc);
}

/** console.table(tabularData[, properties]): primitives print like
 * log; objects, arrays, and checked-dynamic values render Node's table
 * in the runtime (cli_table's layout over util.inspect cells). `inst`
 * selects the instance form (its own stdout and indentation); null is the
 * global console. */
function lowerConsoleTable(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
  inst: IrExpr | null = null,
): IrExpr {
  const stmts: IrStmt[] = [];
  const [dataNode, propsNode, ...rest] = expr.arguments.nodes;
  const logLine = (text: IrExpr): IrExpr =>
    inst === null
      ? consoleWrite(true, [text], loc)
      : {
          kind: "libCall",
          fn: "console.write",
          args: [inst, text, boolLit(false, loc)],
          type: VOID,
          loc,
        };
  if (dataNode === undefined) return logLine(strLit("undefined", loc));
  let data = lowerer.lowerExpr(dataNode);
  let props =
    propsNode === undefined || isUndefinedLiteral(propsNode) ? null : lowerer.lowerExpr(propsNode);
  if (rest.length > 0) {
    // The ignored arguments evaluate after the two the table reads.
    data = hoist(lowerer, stmts, "%consoleTable", data, loc);
    if (props !== null) props = hoist(lowerer, stmts, "%consoleTableProps", props, loc);
    evaluateIgnored(lowerer, rest, stmts, loc);
  }
  const t = data.type;
  if (
    props === null &&
    (t.kind === "f64" ||
      t.kind === "string" ||
      t.kind === "bool" ||
      t.kind === "undefinedT" ||
      t.kind === "nullT")
  ) {
    // Node: `if (tabularData === null || typeof tabularData !== 'object')
    // return this.log(tabularData)`.
    const text =
      inst === null
        ? lowerConsoleArg(lowerer, dataNode, data, "console.table", loc)
        : formatRestValue(lowerer, dataNode, data, loc);
    return seq(stmts, logLine(text), loc);
  }
  const boxable =
    t.kind === "dyn" ||
    (t.kind !== "func" &&
      t.kind !== "bytes" &&
      t.kind !== "map" &&
      t.kind !== "set" &&
      lowerer.dynConvertible(t));
  if (!boxable) {
    lowerer.noLowering(
      `console.table of '${lowerer.fmt(t)}' values`,
      dataNode,
      "arrays, plain objects, and their JSON-shaped contents are the lowered tables",
    );
  }
  if (props !== null) {
    const pt = props.type;
    if (!(pt.kind === "array" && pt.elem.kind === "string")) {
      lowerer.noLowering(
        `console.table with a '${lowerer.fmt(pt)}' properties argument`,
        propsNode!,
        "pass an array of property names",
      );
    }
  }
  const box = (v: IrExpr): IrExpr =>
    v.type.kind === "dyn" ? v : { kind: "dynFrom", value: v, type: DYN, loc };
  const cards: IrExpr[] = [box(data), props === null ? dynUndefinedExpr(loc) : box(props)];
  const call: IrExpr = {
    kind: "libCall",
    fn: inst === null ? "console.table" : "console.instTable",
    args: inst === null ? cards : [inst, ...cards],
    type: VOID,
    loc,
  };
  return seq(stmts, call, loc);
}

/** console.<member>(...) on the global console for the members past the
 * output set. */
export function lowerConsoleMethodCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: ConsoleMethodMember,
  loc: SrcLoc,
): IrExpr {
  const args = expr.arguments.nodes;
  switch (member) {
    case "trace":
      // Node's console.trace: the stderr line "Trace[: args]", then the
      // captured frames (scriptc's own frames; SEMANTICS divergence 11).
      return lowerConsoleOutput(lowerer, expr, false, "console.trace", loc, "console.trace");
    case "dirxml":
      return lowerConsoleOutput(lowerer, expr, true, "console.dirxml", loc);
    case "group":
    case "groupCollapsed": {
      const indent: IrExpr = {
        kind: "libCall",
        fn: "console.group",
        args: [numLit(1, loc)],
        type: VOID,
        loc,
      };
      if (args.length === 0) return indent;
      const label = lowerConsoleOutput(lowerer, expr, true, `console.${member}`, loc);
      return seq([{ kind: "exprStmt", expr: label, loc }], indent, loc);
    }
    case "groupEnd": {
      const stmts: IrStmt[] = [];
      evaluateIgnored(lowerer, args, stmts, loc);
      return seq(
        stmts,
        { kind: "libCall", fn: "console.group", args: [numLit(-1, loc)], type: VOID, loc },
        loc,
      );
    }
    case "count": {
      const stmts: IrStmt[] = [];
      const raw = rawLabel(lowerer, member, args[0]);
      const rawRef = raw === null ? null : hoist(lowerer, stmts, "%consoleLabel", raw, loc);
      evaluateIgnored(lowerer, args.slice(1), stmts, loc);
      return seq(
        stmts,
        { kind: "libCall", fn: "console.count", args: [labelText(rawRef, loc)], type: VOID, loc },
        loc,
      );
    }
    case "countReset": {
      const stmts: IrStmt[] = [];
      const raw = rawLabel(lowerer, member, args[0]);
      const rawRef = raw === null ? null : hoist(lowerer, stmts, "%consoleLabel", raw, loc);
      evaluateIgnored(lowerer, args.slice(1), stmts, loc);
      // Node looks the RAW label up (`counts.has(label)`) and deletes its
      // string form: only string labels (and the default) ever reset.
      const boxed: IrExpr =
        rawRef === null
          ? dynUndefinedExpr(loc)
          : rawRef.type.kind === "dyn"
            ? rawRef
            : { kind: "dynFrom", value: rawRef, type: DYN, loc };
      return seq(
        stmts,
        emitWarning(
          { kind: "libCall", fn: "console.countReset", args: [boxed], type: STRING, loc },
          loc,
        ),
        loc,
      );
    }
    case "time": {
      const stmts: IrStmt[] = [];
      const raw = rawLabel(lowerer, member, args[0]);
      const rawRef = raw === null ? null : hoist(lowerer, stmts, "%consoleLabel", raw, loc);
      evaluateIgnored(lowerer, args.slice(1), stmts, loc);
      return seq(
        stmts,
        emitWarning(
          {
            kind: "libCall",
            fn: "console.time",
            args: [labelText(rawRef, loc)],
            type: STRING,
            loc,
          },
          loc,
        ),
        loc,
      );
    }
    case "timeEnd":
    case "timeLog":
      return lowerConsoleTimeLog(lowerer, expr, member, loc);
    case "assert":
      return lowerConsoleAssert(lowerer, expr, loc);
    case "dir": {
      const stmts: IrStmt[] = [];
      const [valueNode, optionsNode, ...rest] = args;
      const rendered =
        valueNode === undefined
          ? strLit("undefined", loc)
          : lowerInspectValue(lowerer, valueNode, optionsNode, loc, true);
      if (rest.length === 0) return consoleWrite(true, [rendered], loc);
      const text = hoist(lowerer, stmts, "%consoleDir", rendered, loc);
      evaluateIgnored(lowerer, rest, stmts, loc);
      return seq(stmts, consoleWrite(true, [text], loc), loc);
    }
    case "table":
      return lowerConsoleTable(lowerer, expr, loc);
    case "clear": {
      const stmts: IrStmt[] = [];
      evaluateIgnored(lowerer, args, stmts, loc);
      return seq(stmts, { kind: "libCall", fn: "console.clear", args: [], type: VOID, loc }, loc);
    }
    case "profile":
    case "profileEnd":
    case "timeStamp": {
      // Inspector-only: without an attached session these print nothing.
      // V8 still converts the first argument to a string, so only
      // primitive arguments lower.
      const stmts: IrStmt[] = [];
      for (const arg of args) {
        const value = lowerer.lowerExpr(arg);
        const k = value.type.kind;
        if (k !== "string" && k !== "f64" && k !== "bool" && k !== "undefinedT" && k !== "nullT") {
          lowerer.noLowering(
            `console.${member} with a '${lowerer.fmt(value.type)}' argument`,
            arg,
            "pass a string label",
          );
        }
        if (value.kind !== "unitLit") stmts.push({ kind: "exprStmt", expr: value, loc });
      }
      return seq(stmts, noop(loc), loc);
    }
  }
}
