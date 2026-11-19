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
import {
  boolLit,
  dynUndefinedExpr,
  nodeThrowExpr,
  numLit,
  strLit,
  varRef,
} from "../../ir/build.js";
import { locOf } from "../program.js";
import { type ConsoleMethodMember } from "./builtins/console.js";
import { jsFuncNameOf, type Lowerer } from "./lowerer.js";
import { ensureBool } from "./lower-exprs.js";
import {
  heldFormatArgs,
  lowerConsoleInspectArg,
  lowerFormatCall,
  lowerInspectValue,
  lowerRuntimeFormat,
  lowerRuntimeInspectDir,
  runtimeFormatString,
  formatStringConverts,
} from "./lower-inspect.js";
import { streamSidesOf } from "./lower-stream.js";
import { programTouchesInspectTables } from "./inspect-tables.js";
import { dynArgumentPack } from "./call-arguments.js";

/** node:console Console instances: a native handle (the checked-dynamic
 * representation the stdlib Console type maps to) over two output
 * targets — process.stdout/process.stderr, or writable streams — plus
 * the ignoreErrors flag. The log/info/debug (stdout) and error/warn
 * (stderr) members lower through util.format into ONE write of the
 * formatted line, exactly Node's kWriteToConsole; the remaining Console
 * surface stays fenced like the global console's. */

const OUTPUT_MEMBERS: ReadonlyMap<string, boolean> = new Map([
  ["log", false],
  ["info", false],
  ["debug", false],
  ["error", true],
  ["warn", true],
]);

const OPTION_KEYS = new Set(["stdout", "stderr", "ignoreErrors"]);

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

/** Whether any module constructs a Console with inspectOptions or
 * colorMode. Such a Console's methods format through the runtime's
 * option-aware entries wherever their call sites sit, so the answer is a
 * program-wide fact, not a lowering-order one (a call lowered before the
 * constructor would otherwise keep the static path). Scanned once; the
 * answer is cached on the lowerer. */
function programConstructsOptionConsole(lowerer: Lowerer): boolean {
  if (lowerer.consoleOptionsFact !== undefined) return lowerer.consoleOptionsFact;
  const modules = lowerer.moduleOrder.length > 0 ? lowerer.moduleOrder : [lowerer.entry];
  let found = false;
  for (const sf of modules) {
    if (found) break;
    ts.walkPreorder(sf, (node) => {
      if (!ts.isNewExpression(node) || !isConsoleCtor(lowerer, node.expression)) return undefined;
      const first = node.arguments?.nodes[0];
      if (first === undefined || !ts.isObjectLiteralExpression(first)) return undefined;
      for (const prop of first.properties.nodes) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const key = prop.name;
        const text = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null;
        if (text === "inspectOptions" || text === "colorMode") {
          found = true;
          return "stop";
        }
      }
      return undefined;
    });
  }
  lowerer.consoleOptionsFact = found;
  return found;
}

function isUndefinedArg(node: ts.Expression | undefined): boolean {
  return (
    node === undefined ||
    (ts.isIdentifier(node) && node.text === "undefined") ||
    ts.isVoidExpression(node)
  );
}

type Target = { fd: number } | { local: string; type: IrType };

type OptionRole =
  | "stdout"
  | "stderr"
  | "ignoreErrors"
  | "groupIndentation"
  | "inspectOptions"
  | "colorMode"
  | "ignored";

/** `new Console(stdout[, stderr][, ignoreErrors])` and `new
 * Console({ stdout, stderr, ignoreErrors })`. Arguments and option
 * initializers evaluate in source order into hidden locals before the
 * handle exists (Node evaluates them before the constructor body); an
 * absent stderr shares stdout's target. */
export function lowerConsoleNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (!isConsoleCtor(lowerer, expr.expression)) return null;
  const loc = locOf(expr);
  const args = expr.arguments?.nodes ?? [];
  const entries: { role: OptionRole; node: ts.Expression | undefined }[] = [];
  /** Effects of the arguments and options that run before the handle
   * exists, in source order (Node evaluates them before its constructor
   * body validates anything). */
  const stmts: IrStmt[] = [];
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
      if (name === null || value === null) {
        lowerer.noLowering(
          "this Console options form",
          prop,
          "spell the options as properties of one object literal",
        );
      }
      if (name === "colorMode") {
        // Node validates 'auto', true and false in its constructor, after
        // the stream checks; the runtime reads the value there.
        entries.push({ role: "colorMode", node: value });
        continue;
      }
      if (name === "groupIndentation") {
        entries.push({ role: "groupIndentation", node: value });
        continue;
      }
      if (name === "inspectOptions") {
        // The methods format with this record's knobs per call.
        entries.push({ role: "inspectOptions", node: value });
        continue;
      }
      if (!OPTION_KEYS.has(name)) {
        // Node destructures the known keys and ignores the rest. The
        // unknown initializer still evaluates, in source order.
        entries.push({ role: "ignored", node: value });
        continue;
      }
      entries.push({ role: name as OptionRole, node: value });
    }
  } else {
    entries.push({ role: "stdout", node: args[0] });
    entries.push({ role: "stderr", node: args[1] });
    entries.push({ role: "ignoreErrors", node: args[2] });
  }
  /** Node's constructor takes a target when `typeof stream.write ===
   * 'function'`. A value whose static type cannot carry one is rejected at
   * run time with ERR_CONSOLE_WRITABLE_STREAM (its expression still
   * evaluates); a value that might carry one — an untyped value, or an
   * object with a write member this runtime has no stream binding for —
   * keeps the compile-time boundary. */
  const target = (node: ts.Expression, role: string): Target | null => {
    if (ts.isPropertyAccessExpression(node)) {
      const member = lowerer.stdlibGlobalMember(node, "process");
      if (member === "stdout") return { fd: 1 };
      if (member === "stderr") return { fd: 2 };
    }
    const value = lowerer.lowerExpr(node);
    const info =
      value.type.kind === "object" ? lowerer.classes.get(value.type.className) : undefined;
    const sides = streamSidesOf(lowerer, info);
    if (sides === "w" || sides === "rw") {
      const local = lowerer.declareHiddenLocal(`%console${role}`, value.type);
      stmts.push({ kind: "varDecl", localId: local.id, init: value, loc });
      return { local: local.id, type: value.type };
    }
    const t = lowerer.typeOf(node);
    const maybeWritable =
      (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0 ||
      lowerer.checker.getPropertyOfType(t, "write") !== undefined;
    if (maybeWritable) {
      lowerer.noLowering(
        `a Console ${role} of type '${lowerer.fmt(value.type)}'`,
        node,
        "process.stdout, process.stderr, and node:stream writables (Writable, Duplex, Transform, PassThrough, and their subclasses) are the supported Console streams",
      );
    }
    // The expression still evaluates in source order; Node's constructor
    // throws only after every option initializer has run.
    if (value.kind !== "unitLit") stmts.push({ kind: "exprStmt", expr: value, loc: value.loc });
    return null;
  };
  let out: Target | null = null;
  let err: Target | null = null;
  let errBad = false;
  let ignore: IrExpr | null = null;
  let groupIndent: IrExpr | null = null;
  let inspectOptions: IrExpr | null = null;
  let colorMode: IrExpr | null = null;
  for (const entry of entries) {
    const node = entry.node;
    if (isUndefinedArg(node)) {
      // `void expr` still evaluates its operand.
      if (node !== undefined && ts.isVoidExpression(node)) {
        stmts.push({ kind: "exprStmt", expr: lowerer.lowerExpr(node), loc });
      }
      if (entry.role === "stdout") out = null;
      else if (entry.role === "stderr") {
        err = null;
        errBad = false;
      } else if (entry.role === "ignoreErrors") ignore = null;
      else if (entry.role === "groupIndentation") groupIndent = null;
      else if (entry.role === "inspectOptions") inspectOptions = null;
      else if (entry.role === "colorMode") colorMode = null;
      continue;
    }
    if (entry.role === "stdout") {
      out = target(node!, "stdout");
    } else if (entry.role === "stderr") {
      err = target(node!, "stderr");
      errBad = err === null;
    } else if (entry.role === "groupIndentation") {
      // Node's validateInteger runs in the runtime, after the stream
      // checks (console.new takes the value as checked-dynamic).
      const value = hoist(
        lowerer,
        stmts,
        "%consoleGroupIndentation",
        lowerer.lowerExprExpecting(node!, DYN),
        loc,
      );
      groupIndent = value;
    } else if (entry.role === "inspectOptions" || entry.role === "colorMode") {
      // Node keeps the inspectOptions record (later mutation shows up in
      // the next write) and validates colorMode in its constructor; the
      // runtime reads both per call, so the methods format through the
      // option-aware entries (lowerConsoleInstanceCall).
      const value = hoist(
        lowerer,
        stmts,
        entry.role === "inspectOptions" ? "%consoleInspectOptions" : "%consoleColorMode",
        lowerer.lowerExprExpecting(node!, DYN),
        loc,
      );
      if (entry.role === "inspectOptions") inspectOptions = value;
      else colorMode = value;
    } else if (entry.role === "ignored") {
      // Node destructures the known keys and ignores the rest; the
      // unknown initializer still evaluates, in source order.
      const value = lowerer.lowerExpr(node!);
      if (value.kind !== "unitLit") stmts.push({ kind: "exprStmt", expr: value, loc });
    } else {
      // Node stores Boolean(ignoreErrors): any value is accepted, and only
      // a false one turns the error handling off.
      const value = ensureBool(lowerer, lowerer.lowerExpr(node!), node!);
      const local = lowerer.declareHiddenLocal("%consoleIgnoreErrors", BOOL);
      stmts.push({ kind: "varDecl", localId: local.id, init: value, loc });
      ignore = varRef(local.id, BOOL, loc);
    }
  }
  const writableError = (role: string): IrExpr =>
    nodeThrowExpr(
      1,
      "ERR_CONSOLE_WRITABLE_STREAM",
      `Console expects a writable stream instance for ${role}`,
      DYN,
      loc,
    );
  if (out === null) {
    // No stdout, or a value Node's writable check rejects: Node validates
    // stdout first, then stderr.
    return { kind: "seqExpr", stmts, result: writableError("stdout"), type: DYN, loc };
  }
  if (errBad) {
    return { kind: "seqExpr", stmts, result: writableError("stderr"), type: DYN, loc };
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
        groupIndent ?? dynUndefinedExpr(loc),
        inspectOptions ?? dynUndefinedExpr(loc),
        colorMode ?? dynUndefinedExpr(loc),
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

/** A Console instance's line from rendered console arguments
 * (lowerConsoleArg's answers): strings verbatim, numbers in inspect's
 * rendering (-0 prints "-0"), booleans spelled out, space-joined exactly
 * like Node's formatter joins a rest-args call. */
function instanceLine(lowerer: Lowerer, parts: readonly IrExpr[], loc: SrcLoc): IrExpr {
  const texts = parts.map((part): IrExpr => {
    if (part.type.kind === "f64")
      return { kind: "libCall", fn: "insp.f64", args: [part], type: STRING, loc };
    if (part.type.kind === "bool")
      return {
        kind: "ternary",
        cond: part,
        then: strLit("true", loc),
        else_: strLit("false", loc),
        type: STRING,
        loc,
      };
    return part;
  });
  if (texts.length === 0) return strLit("", loc);
  const joined: IrExpr[] = [];
  texts.forEach((text, i) => {
    if (i > 0) joined.push(strLit(" ", loc));
    joined.push(text);
  });
  return joined.length === 1 ? joined[0]! : concat(joined, loc);
}

/** `c.log(...)` and the rest of the Console member surface on a
 * stdlib-Console-typed receiver that is not the global console itself (that
 * path keeps its direct console lowering): the receiver evaluates first,
 * into one hidden local, then the member's arguments. The output members
 * write one util.format rendering; the stateful members read and write the
 * instance's own counters, timers and group indentation, and print to the
 * instance's own stdout/stderr targets. */
export function lowerConsoleInstanceCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr | null {
  const member = lowerConsoleInstanceMemberCall(lowerer, call, loc);
  return member === null ? null : flattenSeq(member);
}

/** One flat sequence: a member lowering's own sequence is spliced in after
 * the receiver's statement, so the emitted expression is a single seqExpr
 * (the emitter reads the statements of a nested sequence inconsistently). */
function flattenSeq(e: IrExpr): IrExpr {
  if (e.kind !== "seqExpr") return e;
  const stmts = [...e.stmts];
  let result = e.result;
  for (;;) {
    const inner = result.kind === "seqExpr" ? flattenSeq(result) : result;
    if (inner.kind !== "seqExpr") {
      result = inner;
      break;
    }
    stmts.push(...inner.stmts);
    result = inner.result;
  }
  return { kind: "seqExpr", stmts, result, type: result.type, loc: e.loc };
}

function lowerConsoleInstanceMemberCall(
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
  const receiver = lowerer.lowerExpr(access.expression);
  if (receiver.type.kind !== "dyn") return null;
  const held = lowerer.declareHiddenLocal("%consoleInstance", DYN);
  const stmts: IrStmt[] = [{ kind: "varDecl", localId: held.id, init: receiver, loc }];
  const handle = (): IrExpr => varRef(held.id, DYN, loc);
  const write = (stdout: boolean, parts: readonly IrExpr[], at: SrcLoc): IrExpr => ({
    kind: "libCall",
    fn: "console.write",
    args: [varRef(held.id, DYN, at), instanceLine(lowerer, parts, at), boolLit(!stdout, at)],
    type: VOID,
    loc: at,
  });
  const call_ = (fn: IrLibFn, args: IrExpr[], type: IrType, at: SrcLoc): IrExpr => ({
    kind: "libCall",
    fn,
    args,
    type,
    loc: at,
  });

  /* A program that constructs any Console with inspectOptions or colorMode
   * formats the instance methods' arguments in the runtime, where the
   * instance's options and colorMode apply per call (scr_inspect.c's
   * console entries). The members Node's Console methods do not format
   * (count/time labels use String, table cells have their own renderer)
   * keep the static lowering. */
  if (programConstructsOptionConsole(lowerer)) {
    const args = call.arguments.nodes;
    const packed = (at: SrcLoc): { stmts: IrStmt[]; pack: () => IrExpr } =>
      dynArgumentPack(lowerer, args, at, { blame: call });
    const withPack = (fn: IrLibFn, extra: (pack: IrExpr) => IrExpr[], at: SrcLoc): IrExpr => {
      const p = packed(at);
      return seq([...stmts, ...p.stmts], call_(fn, [handle(), ...extra(p.pack())], VOID, at), at);
    };
    switch (member) {
      case "log":
      case "info":
      case "debug":
      case "warn":
      case "error": {
        const index = ["log", "info", "debug", "warn", "error"].indexOf(member);
        return withPack("console.instWriteArgs", (pack) => [numLit(index, loc), pack], loc);
      }
      case "dirxml":
        return withPack("console.instDirxmlArgs", (pack) => [pack], loc);
      case "trace":
        return withPack("console.instTraceArgs", (pack) => [pack], loc);
      case "assert":
        return withPack("console.instAssertArgs", (pack) => [pack], loc);
      case "group":
      case "groupCollapsed":
        return withPack(
          "console.instGroupArgs",
          (pack) => [pack, boolLit(member === "groupCollapsed", loc)],
          loc,
        );
      case "dir": {
        const p = packed(loc);
        const dirStmts = [...stmts, ...p.stmts];
        const rendered = hoist(
          lowerer,
          dirStmts,
          "%consoleDir",
          call_("console.instDirArgs", [handle(), p.pack()], STRING, loc),
          loc,
        );
        return seq(dirStmts, write(true, [rendered], loc), loc);
      }
      default:
        break;
    }
  }

  const outToStderr = member === "dirxml" ? false : OUTPUT_MEMBERS.get(member);
  if (outToStderr !== undefined) {
    return seq(stmts, write(!outToStderr, [lowerFormatCall(lowerer, call, loc, false)], loc), loc);
  }

  switch (member) {
    case "trace": {
      // Node's Console.trace: the stderr line "Trace[: args]" and the
      // captured frames, written to the instance's stderr as one chunk.
      const text =
        call.arguments.nodes.length === 0
          ? strLit("", loc)
          : lowerFormatCall(lowerer, call, loc, false);
      return seq(stmts, call_("console.instTrace", [handle(), text], VOID, loc), loc);
    }
    case "assert":
      return seq(
        stmts,
        lowerConsoleAssert(lowerer, call, loc, (parts, at) => write(false, parts, at)),
        loc,
      );
    case "dir": {
      const args = call.arguments.nodes;
      const [valueNode, optionsNode, ...rest] = args;
      const rendered =
        valueNode === undefined
          ? strLit("undefined", loc)
          : programTouchesInspectTables(lowerer)
            ? lowerRuntimeInspectDir(lowerer, valueNode, optionsNode, args.length, loc)
            : lowerInspectValue(lowerer, valueNode, optionsNode, loc, true);
      const text = hoist(lowerer, stmts, "%consoleDir", rendered, loc);
      evaluateIgnored(lowerer, rest, stmts, loc);
      return seq(stmts, write(true, [text], loc), loc);
    }
    case "table":
      return seq(
        stmts,
        lowerConsoleTable(lowerer, call, loc, {
          log: (parts, at) => write(true, parts, at),
          table: (data, props, at) =>
            call_("console.instTable", [varRef(held.id, DYN, at), data, props], VOID, at),
        }),
        loc,
      );
    case "clear": {
      evaluateIgnored(lowerer, call.arguments.nodes, stmts, loc);
      return seq(stmts, call_("console.instClear", [handle()], VOID, loc), loc);
    }
    case "count": {
      const stmts_: IrStmt[] = [...stmts];
      const args = call.arguments.nodes;
      const raw = rawLabel(lowerer, member, args[0]);
      const rawRef = raw === null ? null : hoist(lowerer, stmts_, "%consoleLabel", raw, loc);
      evaluateIgnored(lowerer, args.slice(1), stmts_, loc);
      return seq(
        stmts_,
        call_("console.instCount", [varRef(held.id, DYN, loc), labelText(rawRef, loc)], VOID, loc),
        loc,
      );
    }
    case "countReset": {
      const stmts_: IrStmt[] = [...stmts];
      const args = call.arguments.nodes;
      const raw = rawLabel(lowerer, member, args[0]);
      const rawRef = raw === null ? null : hoist(lowerer, stmts_, "%consoleLabel", raw, loc);
      evaluateIgnored(lowerer, args.slice(1), stmts_, loc);
      const boxed: IrExpr =
        rawRef === null
          ? dynUndefinedExpr(loc)
          : rawRef.type.kind === "dyn"
            ? rawRef
            : { kind: "dynFrom", value: rawRef, type: DYN, loc };
      return seq(
        stmts_,
        emitWarning(
          call_("console.instCountReset", [varRef(held.id, DYN, loc), boxed], STRING, loc),
          loc,
        ),
        loc,
      );
    }
    case "time": {
      const stmts_: IrStmt[] = [...stmts];
      const args = call.arguments.nodes;
      const raw = rawLabel(lowerer, member, args[0]);
      const rawRef = raw === null ? null : hoist(lowerer, stmts_, "%consoleLabel", raw, loc);
      evaluateIgnored(lowerer, args.slice(1), stmts_, loc);
      return seq(
        stmts_,
        emitWarning(
          call_(
            "console.instTime",
            [varRef(held.id, DYN, loc), labelText(rawRef, loc)],
            STRING,
            loc,
          ),
          loc,
        ),
        loc,
      );
    }
    case "timeEnd":
    case "timeLog":
      return seq(
        stmts,
        lowerConsoleTimeLog(lowerer, call, member, loc, {
          timeEnd: "console.instTimeEnd",
          timeLog: "console.instTimeLog",
          handle: handle(),
          write,
        }),
        loc,
      );
    case "group":
    case "groupCollapsed": {
      const indent = call_("console.instGroup", [handle(), numLit(1, loc)], VOID, loc);
      const args = call.arguments.nodes;
      const label =
        args.length === 0 ? null : write(true, [lowerFormatCall(lowerer, call, loc, false)], loc);
      return label === null
        ? seq(stmts, indent, loc)
        : seq([...stmts, { kind: "exprStmt", expr: label, loc }], indent, loc);
    }
    case "groupEnd": {
      evaluateIgnored(lowerer, call.arguments.nodes, stmts, loc);
      return seq(stmts, call_("console.instGroup", [handle(), numLit(-1, loc)], VOID, loc), loc);
    }
    case "profile":
    case "profileEnd":
    case "timeStamp":
      // These exist on the global console only: Node's Console instances
      // do not define them, so the call is a TypeError there. Refuse
      // rather than print nothing.
      lowerer.noLowering(
        `Console.${member}`,
        call,
        "Node's Console instances have no profile, profileEnd or timeStamp member — only the global console does",
      );
  }
  lowerer.noLowering(
    `Console.${member}`,
    call,
    "log, info, debug, error, warn, dir, dirxml, time, timeEnd, timeLog, trace, assert, clear, count, countReset, group, groupCollapsed, groupEnd and table are the lowered Console members",
  );
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

/** Where a timeEnd/timeLog line comes from and goes: the global console's
 * own timers and stdout intrinsic, or a Console instance's own. */
type ConsoleTimeTarget = {
  timeEnd: IrLibFn;
  timeLog: IrLibFn;
  write: (stdout: boolean, parts: IrExpr[], loc: SrcLoc) => IrExpr;
  handle?: IrExpr;
};

const GLOBAL_TIME_TARGET: ConsoleTimeTarget = {
  timeEnd: "console.timeEnd",
  timeLog: "console.timeLog",
  write: (stdout, parts, loc) => consoleWrite(stdout, parts, loc),
};

/** Where console.table's output goes: the global console's log intrinsic,
 * or a Console instance's own stdout. */
type ConsoleTableTarget = {
  log: (parts: IrExpr[], loc: SrcLoc) => IrExpr;
  table: (data: IrExpr, props: IrExpr, loc: SrcLoc) => IrExpr;
};

const GLOBAL_TABLE_TARGET: ConsoleTableTarget = {
  log: (parts, loc) => consoleWrite(true, parts, loc),
  table: (data, props, loc) => ({
    kind: "libCall",
    fn: "console.table",
    args: [data, props],
    type: VOID,
    loc,
  }),
};

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
  // A program that reads util.inspect's value can change the tables every
  // console line's inspection reads (defaultOptions, colors, styles), so
  // the whole line renders through the runtime formatter, which reads them
  // per call.
  if (programTouchesInspectTables(lowerer))
    return emitLine([lowerRuntimeFormat(lowerer, expr.arguments.nodes, loc)]);
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
  target: ConsoleTimeTarget = GLOBAL_TIME_TARGET,
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
      fn: member === "timeEnd" ? target.timeEnd : target.timeLog,
      args: target.handle === undefined ? [label] : [target.handle, label],
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
    then: [{ kind: "exprStmt", expr: target.write(true, [line, ...rendered], loc), loc }],
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
 * so a format string still formats. `emit` is that warn write: the global
 * console's stderr intrinsic, or a Console instance's own stderr target. */
function lowerConsoleAssert(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
  emit: (parts: IrExpr[], loc: SrcLoc) => IrExpr = (parts, at) => consoleWrite(false, parts, at),
): IrExpr {
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
    failed = emit([lowerFormatCall(lowerer, expr, loc, false, args, "Assertion failed: ")], loc);
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
    failed = emit(rendered, loc);
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
 * in the runtime (cli_table's layout over util.inspect cells). */
function lowerConsoleTable(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
  target: ConsoleTableTarget = GLOBAL_TABLE_TARGET,
): IrExpr {
  const stmts: IrStmt[] = [];
  const [dataNode, propsNode, ...rest] = expr.arguments.nodes;
  if (dataNode === undefined) return target.log([strLit("undefined", loc)], loc);
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
    return seq(
      stmts,
      target.log([lowerConsoleArg(lowerer, dataNode, data, "console.table", loc)], loc),
      loc,
    );
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
  const call = target.table(box(data), props === null ? dynUndefinedExpr(loc) : box(props), loc);
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
    case "createTask": {
      // Node's console.createTask: the runtime console member builds the
      // task object (one plain object whose `run` calls the callback it is
      // given and answers the callback's result). The arguments evaluate
      // in order at the call, as any call's do.
      if (args.some((arg) => ts.isSpreadElement(arg))) {
        lowerer.unsupported("SC1090", expr, "console.createTask with a spread argument");
      }
      const callee: IrExpr = {
        kind: "dynKeyGet",
        value: { kind: "libCall", fn: "console.native", args: [], type: DYN, loc },
        key: { kind: "strLit", value: "createTask", type: STRING, loc },
        type: DYN,
        loc,
      };
      return {
        kind: "dynCall",
        callee,
        calleeName: "console.createTask",
        args: args.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
        type: DYN,
        loc,
      };
    }
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
          : programTouchesInspectTables(lowerer)
            ? lowerRuntimeInspectDir(lowerer, valueNode, optionsNode, args.length, loc)
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
