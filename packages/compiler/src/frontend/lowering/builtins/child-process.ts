import { recordToEnvPairs } from "./environment.js";
import { boolLit, nodeThrowExpr, numLit, strLit, varRef } from "../../../ir/build.js";
import { keyedHelperName } from "../stable-names.js";
import { InternalCompilerError } from "../../../errors.js";
import { resolve } from "node:path";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { conditionalSpreadOf } from "../expressions/object-literals.js";
import {
  BOOL,
  CHILD_T,
  DYN,
  F64,
  type IrExpr,
  type IrStmt,
  type IrType,
  SPAWNRES_T,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  arrayOf,
} from "../../../ir/ir.js";
import { staticForkModulePath } from "../../fork-target.js";
import { tsgoPath } from "../../dts-paths.js";
import { optionMember, stripTypeCasts } from "./arguments.js";

/** The child-process args list: one string[] value. An omitted list
 * completes to an empty literal (Node's default); an array LITERAL
 * builds element-wise (its contextual type is the optional parameter's
 * `string[] | undefined`, which the generic literal path cannot map —
 * the Set-seed situation exactly); everything else lowers as itself. */
export function lowerChildArgsArg(
  lowerer: Lowerer,
  node: ts.Expression | undefined,
  loc: SrcLoc,
): IrExpr {
  if (!node) return { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc };
  if (ts.isArrayLiteralExpression(node) && !node.elements.nodes.some(ts.isSpreadElement)) {
    const elems = node.elements.nodes.map((el) => lowerer.lowerExprExpecting(el, STRING));
    return { kind: "arrayLit", elems, type: arrayOf(STRING), loc: locOf(node) };
  }
  return lowerer.lowerExprExpecting(node, arrayOf(STRING));
}

/** True when the args slot is statically empty (omitted, `undefined`, or an
 * empty array literal): the shape the shell forms accept. Node joins the
 * arguments unescaped and warns DEP0190 whenever a non-empty list meets
 * `shell: true`, and a native build has no warning channel to match it. */
function staticallyEmptyArgs(node: ts.Expression | undefined): boolean {
  if (!node) return true;
  const bare = stripTypeCasts(node);
  if (ts.isIdentifier(bare) && bare.text === "undefined") return true;
  return ts.isArrayLiteralExpression(bare) && bare.elements.nodes.length === 0;
}

/** The signal names Node's table (and the runtime's twin) resolves —
 * killSignal literals are validated HERE so an unknown name is a
 * compile-time fence instead of Node's runtime ERR_UNKNOWN_SIGNAL. */
const NODE_SIGNAL_NAMES = new Set([
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGILL",
  "SIGTRAP",
  "SIGABRT",
  "SIGIOT",
  "SIGBUS",
  "SIGFPE",
  "SIGKILL",
  "SIGUSR1",
  "SIGSEGV",
  "SIGUSR2",
  "SIGPIPE",
  "SIGALRM",
  "SIGTERM",
  "SIGCHLD",
  "SIGCONT",
  "SIGSTOP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGVTALRM",
  "SIGPROF",
  "SIGWINCH",
  "SIGSYS",
  "SIGIO",
  "SIGINFO",
]);

/** `spawnSync(command, args?, options?)` → one cp.spawnSync /
 * cp.spawnSyncOpts libCall. An omitted args list completes to an empty
 * string[] literal (Node's default). The options argument must be an
 * object LITERAL whose members are drawn from the honestly-implemented
 * set: `encoding` (the "utf8"/"utf-8" literal — the runtime captures
 * utf8 unconditionally, and the option flips @types/node's
 * stdout/stderr to string), `timeout` (ms — killSignal fires at the
 * deadline and the result carries error: ETIMEDOUT + the signal, never
 * a throw: Node's spawnSync shape), `killSignal` (a signal-name
 * literal, validated against Node's table), `stdio` (the "pipe"/
 * "ignore"/"inherit" string form or a 3-tuple of those — non-piped
 * outputs read "" where Node types them null, spawnSync's documented
 * stance), `env` (a REPLACEMENT environment), `cwd` (the child's
 * directory), `input` (the string piped to its stdin, `| undefined`
 * meaning absent), `shell` (a boolean literal: the complete command line
 * runs through /bin/sh -c, with an empty args list only — Node warns
 * DEP0190 for separate shell args), and
 * `windowsHide` (a POSIX no-op, evaluated for side effects). Everything
 * else (maxBuffer, ...) fences by name. A TYPED options value
 * (SpawnSyncOptionsWithStringEncoding) reads its members at the call.
 * The bare `{ encoding: "utf8" }` shape keeps its historical
 * cp.spawnSync lowering. */
export function lowerSpawnSyncCall(lowerer: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  if (expr.arguments.nodes.length > 3 || expr.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      "spawnSync with this argument shape",
      expr,
      "the supported form is spawnSync(command, args?, options?)",
    );
  }
  const cmd = lowerer.lowerExprExpecting(expr.arguments.nodes[0]!, STRING);
  const argv = lowerChildArgsArg(lowerer, expr.arguments.nodes[1], loc);
  const optsNode = expr.arguments.nodes[2];

  let timeout: IrExpr = numLit(0, loc);
  let killSignal: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
  // stdio modes (scr_child.c's core): stdin 0 = /dev/null ("pipe" with
  // no input and "ignore" both read nothing), 2 = inherit; stdout/
  // stderr 0 = capture, 1 = ignore, 2 = inherit.
  let inMode = 0,
    outMode = 0,
    errMode = 0;
  // stdio[0] is a pipe only when the option never says otherwise: "ignore"
  // and "inherit" both take the child's fd 0 away, and Node drops `input`
  // there instead of piping it.
  let stdinPiped = true;
  // A RUNTIME stdio string (the defaultRunner idiom: `options?.stdio ??
  // "pipe"`) — accepted when its TYPE proves every arm is a supported
  // literal; the runtime maps the value to the modes at the call.
  let stdioStr: IrExpr | null = null;
  // The `env` option's [k,v,...] pairs, which replace the child's environment.
  let envPairs: IrExpr | null = null;
  // `cwd` and `input` (the SCR_CHILD_CP_OPTIONS build). Presence rides
  // apart from the value: "" is an ABSENT cwd (the runtime's len-0 test
  // — a real empty cwd is invalid anyway) and undefined input means no
  // stdin pipe at all, where "" pipes one that ends immediately.
  const emptyStr: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
  let cwd: IrExpr = emptyStr;
  let input: IrExpr = emptyStr;
  let hasInput: IrExpr = boolLit(false, loc);
  // Node's shell form: the command line runs through /bin/sh -c.
  let shell: IrExpr = boolLit(false, loc);
  let extOptions = false; // cwd, input, or shell present: the extended entry point
  let plain = true; // no behavior-changing option: the historical libCall
  // A union-typed `input` is read once into a hidden local that its
  // presence test and its value share, so a getter or a call in the
  // member runs exactly once, as the options object's evaluation does.
  let inputRead: { id: string; init: IrExpr } | null = null;
  // The options whose values reach the call, in source order: the
  // extended entry point's prelude evaluates them in this order.
  const optionOrder: ("timeout" | "cwd" | "env" | "input")[] = [];

  if (optsNode) {
    if (!ts.isObjectLiteralExpression(optsNode)) {
      const runtime = lowerSpawnSyncRuntimeOptions(lowerer, optsNode, expr.arguments.nodes[1], loc);
      if (runtime) {
        const call = (fn: "cp.spawnSyncExt" | "cp.spawnSyncExtEnv", extra: IrExpr[]): IrExpr => ({
          kind: "libCall",
          fn,
          args: [
            cmd,
            argv,
            runtime.timeout,
            killSignal,
            runtime.inMode,
            runtime.outMode,
            runtime.errMode,
            runtime.cwd,
            runtime.input,
            runtime.hasInput,
            runtime.shell,
            ...extra,
          ],
          type: SPAWNRES_T,
          loc,
        });
        // An absent `env` inherits our environment; a present one replaces
        // it. The two entry points differ only in that argument, so the
        // member's presence test picks one at the call.
        if (runtime.hasEnv !== null && runtime.envPairs !== null) {
          return {
            kind: "ternary",
            cond: runtime.hasEnv,
            then: call("cp.spawnSyncExtEnv", [runtime.envPairs]),
            else_: call("cp.spawnSyncExt", []),
            type: SPAWNRES_T,
            loc,
          };
        }
        return call("cp.spawnSyncExt", []);
      }
      lowerer.noLowering(
        "spawnSync with a non-literal options argument",
        optsNode,
        "pass the options inline so each member can be checked, or give them the SpawnSyncOptionsWithStringEncoding type (killSignal stays literal)",
      );
    }
    const applyStdio = (node: ts.Expression): void => {
      const modeOf = (v: string, fd: 0 | 1 | 2): void => {
        if (v === "pipe") return; // the default modes
        if (fd === 0) stdinPiped = false;
        if (v === "ignore") {
          if (fd === 1) outMode = 1;
          if (fd === 2) errMode = 1;
          return;
        }
        if (v === "inherit") {
          if (fd === 0) inMode = 2;
          if (fd === 1) outMode = 2;
          if (fd === 2) errMode = 2;
          return;
        }
        lowerer.noLowering(
          `spawnSync with stdio "${v}"`,
          node,
          '"pipe", "ignore", and "inherit" are the supported stdio modes',
        );
      };
      const t = lowerer.typeOf(node);
      if (t.isStringLiteralType()) {
        modeOf(t.value, 0);
        modeOf(t.value, 1);
        modeOf(t.value, 2);
        return;
      }
      if (ts.isArrayLiteralExpression(node) && node.elements.nodes.length === 3) {
        node.elements.nodes.forEach((el, i) => {
          const et = lowerer.typeOf(el);
          if (!et.isStringLiteralType()) {
            lowerer.noLowering("spawnSync stdio tuple entries beyond string literals", el);
          }
          modeOf(et.value, i as 0 | 1 | 2);
        });
        return;
      }
      // A runtime string whose TYPE pins every possible value to the
      // supported literals — the modes resolve at the call instead.
      const arms: readonly ts.Type[] = t.isUnionType() ? ts.constituentTypes(t) : [t];
      if (
        arms.length > 0 &&
        arms.every(
          (a) =>
            a.isStringLiteralType() &&
            (a.value === "pipe" || a.value === "ignore" || a.value === "inherit"),
        )
      ) {
        stdioStr = lowerer.lowerExprExpecting(node, STRING);
        return;
      }
      lowerer.noLowering(
        "spawnSync with this stdio option",
        node,
        'stdio takes a "pipe"/"ignore"/"inherit" literal (or a value typed as a union of those), or a 3-tuple of literals',
      );
    };
    for (const p of optsNode.properties.nodes) {
      const m = optionMember(p);
      if (!m) {
        lowerer.noLowering(
          "spawnSync with this options shape",
          p,
          "spreads and computed keys have no lowering — write each member inline",
        );
      }
      switch (m.name) {
        case "encoding": {
          const t = lowerer.typeOf(m.value);
          if (!t.isStringLiteralType() || (t.value !== "utf8" && t.value !== "utf-8")) {
            lowerer.noLowering(
              "spawnSync with a non-utf8 encoding",
              m.value,
              'outputs are captured as utf8 — pass { encoding: "utf8" }',
            );
          }
          break;
        }
        case "timeout":
          timeout = lowerer.lowerExprExpecting(m.value, F64);
          optionOrder.push("timeout");
          plain = false;
          break;
        case "killSignal": {
          const t = lowerer.typeOf(m.value);
          if (!t.isStringLiteralType() || !NODE_SIGNAL_NAMES.has(t.value)) {
            lowerer.noLowering(
              "spawnSync with this killSignal",
              m.value,
              'a signal-name literal from Node\'s table ("SIGTERM", "SIGKILL", ...) is the supported form',
            );
          }
          killSignal = { kind: "strLit", value: t.value, type: STRING, loc };
          plain = false;
          break;
        }
        case "stdio":
          applyStdio(m.value);
          plain = false;
          break;
        case "windowsHide":
          lowerer.lowerExpr(m.value); // Node no-op on POSIX
          break;
        case "env":
          // A REPLACEMENT environment, as for spawn and execFileSync.
          envPairs = recordToEnvPairs(lowerer, m.value);
          optionOrder.push("env");
          plain = false;
          break;
        case "cwd":
          cwd = lowerer.lowerExprExpecting(m.value, STRING);
          optionOrder.push("cwd");
          extOptions = true;
          plain = false;
          break;
        case "shell":
          if (m.value.kind === ts.SyntaxKind.TrueKeyword) {
            // Node joins [command, ...args] with single spaces and warns
            // DEP0190 for a non-empty list; a native build has no warning
            // channel, so it refuses the form instead of dropping the
            // warning Node prints.
            if (!staticallyEmptyArgs(expr.arguments.nodes[1])) {
              lowerer.noLowering(
                "spawnSync with shell enabled and separate arguments",
                expr.arguments.nodes[1]!,
                "put the complete shell command in the first argument and pass [] (Node warns DEP0190 for unescaped shell arguments, and a native build cannot report that warning)",
              );
            }
            shell = boolLit(true, loc);
            extOptions = true;
            plain = false;
          } else if (m.value.kind === ts.SyntaxKind.FalseKeyword) {
            shell = boolLit(false, loc); // Node's default
          } else {
            lowerer.noLowering(
              "spawnSync with a non-literal shell option",
              m.value,
              "shell must be a boolean literal",
            );
          }
          break;
        case "input": {
          // string | undefined, Node's exact member semantics (see
          // execFileSync): the undefined arm is an ABSENT option. The
          // presence test and the value share ONE read (the hidden local
          // below), so any expression qualifies and a getter or call in it
          // runs exactly once, as the options object's evaluation does.
          if (lowerer.typeOf(m.value).flags & ts.TypeFlags.Undefined) break;
          const it = lowerer.mapTypeOf(lowerer.typeOf(m.value));
          const uTag = it?.kind === "union" ? lowerer.armTag(it.unionId, UNDEFINED_T) : -1;
          const sTag = it?.kind === "union" ? lowerer.armTag(it.unionId, STRING) : -1;
          if (it?.kind === "union" && uTag >= 0 && sTag >= 0) {
            const readValue = lowerer.lowerExpr(m.value);
            const slot = lowerer.declareHiddenLocal("%spawnSyncInput", readValue.type);
            inputRead = { id: slot.id, init: readValue };
            const read: IrExpr = varRef(slot.id, readValue.type, loc);
            hasInput = {
              kind: "unionIsTag",
              unionId: it.unionId,
              tag: uTag,
              negated: true,
              value: read,
              type: BOOL,
              loc,
            };
            input = {
              kind: "ternary",
              cond: {
                kind: "unionIsTag",
                unionId: it.unionId,
                tag: uTag,
                negated: false,
                value: read,
                type: BOOL,
                loc,
              },
              then: emptyStr,
              else_: {
                kind: "unionNarrow",
                unionId: it.unionId,
                tag: sTag,
                value: read,
                type: STRING,
                loc,
              },
              type: STRING,
              loc,
            };
            optionOrder.push("input");
            extOptions = true;
            plain = false;
            break;
          }
          input = lowerer.lowerExprExpecting(m.value, STRING);
          optionOrder.push("input");
          hasInput = boolLit(true, loc);
          extOptions = true;
          plain = false;
          break;
        }
        default:
          lowerer.noLowering(
            `spawnSync option '${m.name}'`,
            p,
            "encoding, timeout, killSignal, stdio, env, cwd, input, shell, and windowsHide are the supported options",
          );
      }
    }
  }
  if (plain) {
    return { kind: "libCall", fn: "cp.spawnSync", args: [cmd, argv], type: SPAWNRES_T, loc };
  }
  if (stdioStr !== null && envPairs !== null) {
    lowerer.noLowering(
      "spawnSync with a runtime stdio value and env",
      optsNode!,
      'pass stdio as a "pipe"/"ignore"/"inherit" literal when env is set',
    );
  }
  if (stdioStr !== null) {
    if (extOptions) {
      lowerer.noLowering(
        "spawnSync with a runtime stdio value and cwd, input, or shell",
        optsNode!,
        'pass stdio as a "pipe"/"ignore"/"inherit" literal when cwd, input, or shell is set',
      );
    }
    return {
      kind: "libCall",
      fn: "cp.spawnSyncStdioStr",
      args: [cmd, argv, timeout, killSignal, stdioStr],
      type: SPAWNRES_T,
      loc,
    };
  }
  if (extOptions) {
    // Node ignores `input` when stdio[0] takes the child's fd 0 away
    // ("ignore" is /dev/null, "inherit" the parent's): the option is dead
    // there, not a pipe. Its expression still runs — Node evaluates the
    // member before the call — so it stays an argument, and `has_input`
    // false keeps it out of the child's stdin.
    const ignoreInput = !stdinPiped;
    // The call's prelude evaluates the command, the arguments and the
    // options in source order, each into a hidden local the call reads, so
    // an earlier option that changes a later one's value (a getter, a call)
    // is seen as in Node. A union `input` lands in the hidden local its tag
    // test and its value share. Literals need no local.
    const prelude: IrStmt[] = [];
    const bind = (name: string, value: IrExpr): IrExpr => {
      if (value.kind === "strLit" || value.kind === "numLit" || value.kind === "boolLit")
        return value;
      const local = lowerer.declareHiddenLocal(name, value.type);
      prelude.push({ kind: "varDecl", localId: local.id, init: value, loc });
      return varRef(local.id, value.type, loc);
    };
    const cmdArg = bind("%spawnSyncCmd", cmd);
    const argvArg = bind("%spawnSyncArgs", argv);
    let timeoutArg = timeout;
    let cwdArg = cwd;
    let inputArg = input;
    let envArg = envPairs;
    for (const option of optionOrder) {
      if (option === "timeout") timeoutArg = bind("%spawnSyncTimeout", timeout);
      else if (option === "cwd") cwdArg = bind("%spawnSyncCwd", cwd);
      else if (option === "env" && envPairs !== null) envArg = bind("%spawnSyncEnv", envPairs);
      else if (option === "input") {
        if (inputRead !== null)
          prelude.push({ kind: "varDecl", localId: inputRead.id, init: inputRead.init, loc });
        else inputArg = bind("%spawnSyncInput", input);
      }
    }
    const call: IrExpr = {
      kind: "libCall",
      fn: envPairs !== null ? "cp.spawnSyncExtEnv" : "cp.spawnSyncExt",
      args: [
        cmdArg,
        argvArg,
        timeoutArg,
        killSignal,
        numLit(inMode, loc),
        numLit(outMode, loc),
        numLit(errMode, loc),
        cwdArg,
        inputArg,
        ignoreInput ? boolLit(false, loc) : hasInput,
        shell,
        ...(envArg !== null ? [envArg] : []),
      ],
      type: SPAWNRES_T,
      loc,
    };
    return prelude.length === 0
      ? call
      : { kind: "seqExpr", stmts: prelude, result: call, type: SPAWNRES_T, loc };
  }
  return {
    kind: "libCall",
    fn: envPairs !== null ? "cp.spawnSyncEnv" : "cp.spawnSyncOpts",
    args: [
      cmd,
      argv,
      timeout,
      killSignal,
      numLit(inMode, loc),
      numLit(outMode, loc),
      numLit(errMode, loc),
      ...(envPairs !== null ? [envPairs] : []),
    ],
    type: SPAWNRES_T,
    loc,
  };
}

/** The RUNTIME half of the spawnSync options story: a non-literal
 * options argument whose type mapped to the interned spawnSync options
 * record (SpawnSyncOptionsWithStringEncoding). cwd/input/timeout/shell
 * read their fields with the literal path's defaults on the undefined
 * arm; the stdio modes compute through an interned helper over the
 * record, and a runtime mode outside "pipe"/"ignore"/"inherit" throws
 * the catchable TypeError the literal path fences at compile time. The
 * options expression re-reads per member, so only side-effect-free reads
 * qualify (the exec-options reader's discipline). Null when the shape
 * isn't the spawnSync options record (the caller keeps its fence). */
function lowerSpawnSyncRuntimeOptions(
  lowerer: Lowerer,
  optsNode: ts.Expression,
  argsNode: ts.Expression | undefined,
  loc: SrcLoc,
): {
  cwd: IrExpr;
  input: IrExpr;
  hasInput: IrExpr;
  timeout: IrExpr;
  shell: IrExpr;
  inMode: IrExpr;
  outMode: IrExpr;
  errMode: IrExpr;
  /** The `env` member's presence test, null when the record has no such
   * member; the pairs ride only the present branch. */
  hasEnv: IrExpr | null;
  envPairs: IrExpr | null;
} | null {
  const opts = lowerer.lowerExpr(optsNode);
  if (opts.type.kind !== "record") return null;
  const shapeId = opts.type.shapeId;
  const shape = lowerer.shapes.get(shapeId);
  const names = shape?.fields.map((f) => f.name).join(",");
  if (names !== "cwd,encoding,env,input,shell,stdio,timeout,windowsHide") return null;
  if (opts.kind !== "varRef" && opts.kind !== "recordGet" && opts.kind !== "fieldGet") {
    lowerer.noLowering(
      "spawnSync with a computed options argument",
      optsNode,
      "the member reads re-read the options — bind the object to a const first",
    );
  }
  // The record carries `shell`, so the call MAY enable the shell at run
  // time. Node joins a non-empty args list unescaped and warns DEP0190
  // there; only an empty list provably never triggers that warning, so the
  // value form accepts the command-line idiom and refuses separate args.
  if (!staticallyEmptyArgs(argsNode)) {
    lowerer.noLowering(
      "spawnSync with a typed options value and separate arguments",
      argsNode!,
      "the options record may enable shell, where Node warns DEP0190 for unescaped arguments — put the complete command in the first argument and pass no args",
    );
  }
  const fieldType = (name: string): IrType => shape!.fields.find((f) => f.name === name)!.type;
  // field ?? default — the undefined arm takes the literal path's default.
  const readOpt = (name: string, dflt: IrExpr, armT: IrType): IrExpr => {
    const ft = fieldType(name);
    if (ft.kind !== "union")
      return { kind: "recordGet", obj: opts, shapeId, field: name, type: ft, loc };
    const uTag = lowerer.armTag(ft.unionId, UNDEFINED_T);
    const vTag = lowerer.armTag(ft.unionId, armT);
    const read: IrExpr = { kind: "recordGet", obj: opts, shapeId, field: name, type: ft, loc };
    return {
      kind: "ternary",
      cond: {
        kind: "unionIsTag",
        unionId: ft.unionId,
        tag: uTag,
        negated: false,
        value: read,
        type: BOOL,
        loc,
      },
      then: dflt,
      else_: { kind: "unionNarrow", unionId: ft.unionId, tag: vTag, value: read, type: armT, loc },
      type: armT,
      loc,
    };
  };
  const emptyStr: IrExpr = strLit("", loc);
  const modeCall = (fd: 0 | 1 | 2): IrExpr => ({
    kind: "call",
    callee: spawnSyncStdioModeHelper(lowerer, shapeId, fieldType("stdio"), fd, loc),
    args: [opts],
    type: F64,
    loc,
  });
  const inMode = modeCall(0);
  // input's PRESENCE rides separately (undefined = the option is absent —
  // no stdin pipe; "" pipes empty stdin), and Node IGNORES it when
  // stdio[0] takes the child's fd 0 away ("ignore"/"inherit"): the option
  // is dead there, not a pipe. Mode 0 is the only stdin mode that honors
  // it.
  const inputT = fieldType("input");
  const hasInputField: IrExpr =
    inputT.kind === "union"
      ? {
          kind: "unionIsTag",
          unionId: inputT.unionId,
          tag: lowerer.armTag(inputT.unionId, UNDEFINED_T),
          negated: true,
          value: { kind: "recordGet", obj: opts, shapeId, field: "input", type: inputT, loc },
          type: BOOL,
          loc,
        }
      : boolLit(true, loc);
  // The `env` member replaces the child's environment. Presence rides
  // apart from the value (an absent option inherits ours): only the
  // present branch converts the record to pairs.
  const envField = shape!.fields.find((f) => f.name === "env");
  let hasEnv: IrExpr | null = null;
  let envPairs: IrExpr | null = null;
  if (envField) {
    const ft = envField.type;
    const readEnv: IrExpr = { kind: "recordGet", obj: opts, shapeId, field: "env", type: ft, loc };
    const pairsOf = (rec: IrType, value: IrExpr): IrExpr | null => {
      if (rec.kind !== "record") return null;
      const helper = lowerer.envToPairsHelper(rec.shapeId, loc);
      return helper === null
        ? null
        : { kind: "call", callee: helper, args: [value], type: arrayOf(STRING), loc };
    };
    if (ft.kind === "union") {
      const arms = lowerer.unions.get(ft.unionId)?.arms ?? [];
      let rec: IrType | null = null;
      for (const arm of arms) {
        if (arm.kind === "record") {
          rec = arm;
          break;
        }
      }
      const uTag = lowerer.armTag(ft.unionId, UNDEFINED_T);
      if (rec !== null && uTag >= 0) {
        hasEnv = {
          kind: "unionIsTag",
          unionId: ft.unionId,
          tag: uTag,
          negated: true,
          value: readEnv,
          type: BOOL,
          loc,
        };
        envPairs = pairsOf(rec, {
          kind: "unionNarrow",
          unionId: ft.unionId,
          tag: lowerer.armTag(ft.unionId, rec),
          value: readEnv,
          type: rec,
          loc,
        });
      }
    } else if (ft.kind === "record") {
      hasEnv = boolLit(true, loc);
      envPairs = pairsOf(ft, readEnv);
    }
    // A member that exists but cannot convert must not fall back to the
    // inheriting entry point: that would silently run the child WITHOUT
    // the environment the caller asked for.
    if (hasEnv === null || envPairs === null) {
      lowerer.noLowering(
        "spawnSync with an unsupported `env` record",
        optsNode,
        "every env value must be a string or `string | undefined` — the replacement environment converts to [key, value] pairs",
      );
    }
  }
  return {
    cwd: readOpt("cwd", emptyStr, STRING),
    input: readOpt("input", emptyStr, STRING),
    hasInput: {
      kind: "logical",
      op: "&&",
      left: hasInputField,
      right: {
        kind: "bin",
        op: "===",
        left: inMode,
        right: numLit(0, loc),
        type: BOOL,
        loc,
      },
      type: BOOL,
      loc,
    },
    timeout: readOpt("timeout", numLit(0, loc), F64),
    shell: readOpt("shell", boolLit(false, loc), BOOL),
    inMode,
    outMode: modeCall(1),
    errMode: modeCall(2),
    hasEnv,
    envPairs,
  };
}

/** Interned `%cp.spawnSyncStdioMode.<fd>` — the runtime stdio-mode
 * computation over the spawnSync options record: undefined stdio keeps
 * the default (every fd piped/captured), a single "pipe"/"ignore"/
 * "inherit" string applies to all three fds, an array reads its fd's
 * entry ("pipe" when the array is short — Node's default per fd). Any
 * other runtime string throws the catchable TypeError the literal path
 * fences at compile time. Mode 0 = pipe (capture for fds 1/2, /dev/null
 * that still honors `input` for fd 0), 1 = ignore, 2 = inherit. */
function spawnSyncStdioModeHelper(
  lowerer: Lowerer,
  shapeId: string,
  stdioT: IrType,
  fd: 0 | 1 | 2,
  loc: SrcLoc,
): string {
  const key = `cp.spawnsyncstdiomode:${shapeId}:${fd}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, `%cp.spawnSyncStdioMode.${fd}`, key);
  lowerer.arrHofHelpers.set(key, name);
  const optsT: IrType = { kind: "record", shapeId };
  const strEq = (l: IrExpr, r: string): IrExpr => ({
    kind: "strEq",
    negated: false,
    left: l,
    right: strLit(r, loc),
    type: BOOL,
    loc,
  });
  const throwType = (msg: IrExpr): IrStmt => ({
    kind: "throw",
    value: {
      kind: "libCall",
      fn: "error.new",
      args: [msg],
      type: { kind: "object", className: "%TypeError" },
      loc,
    },
    loc,
  });
  const concat = (l: IrExpr, r: IrExpr): IrExpr => ({
    kind: "strConcat",
    left: l,
    right: r,
    type: STRING,
    loc,
  });
  const o = varRef("o.0", optsT, loc);
  const locals = [
    { id: "o.0", name: "o", type: optsT, mutable: false },
    { id: "s.0", name: "s", type: STRING, mutable: false },
    { id: "a.0", name: "a", type: arrayOf(STRING), mutable: false },
  ];
  const modeStmts = (s: IrExpr): IrStmt[] => [
    {
      kind: "if",
      cond: strEq(s, "pipe"),
      then: [{ kind: "return", value: numLit(0, loc), loc }],
      else_: null,
      loc,
    },
    {
      kind: "if",
      cond: strEq(s, "ignore"),
      then: [{ kind: "return", value: numLit(1, loc), loc }],
      else_: null,
      loc,
    },
    {
      kind: "if",
      cond: strEq(s, "inherit"),
      then: [{ kind: "return", value: numLit(2, loc), loc }],
      else_: null,
      loc,
    },
    throwType(
      concat(
        concat(strLit('spawnSync stdio "', loc), s),
        strLit(
          '" has no static lowering ("pipe", "ignore", and "inherit" are the supported modes)',
          loc,
        ),
      ),
    ),
  ];
  if (stdioT.kind !== "union")
    throw new InternalCompilerError("emitter bug: spawnSync stdio is not a union");
  const uTag = lowerer.armTag(stdioT.unionId, UNDEFINED_T);
  const sTag = lowerer.armTag(stdioT.unionId, STRING);
  const aTag = lowerer.armTag(stdioT.unionId, arrayOf(STRING));
  const sd: IrExpr = { kind: "recordGet", obj: o, shapeId, field: "stdio", type: stdioT, loc };
  const body: IrStmt[] = [
    {
      kind: "if",
      cond: {
        kind: "unionIsTag",
        unionId: stdioT.unionId,
        tag: uTag,
        negated: false,
        value: sd,
        type: BOOL,
        loc,
      },
      then: [{ kind: "return", value: numLit(0, loc), loc }],
      else_: null,
      loc,
    },
    {
      kind: "if",
      cond: {
        kind: "unionIsTag",
        unionId: stdioT.unionId,
        tag: sTag,
        negated: false,
        value: sd,
        type: BOOL,
        loc,
      },
      then: [
        {
          kind: "varDecl",
          localId: "s.0",
          init: {
            kind: "unionNarrow",
            unionId: stdioT.unionId,
            tag: sTag,
            value: sd,
            type: STRING,
            loc,
          },
          loc,
        },
        ...modeStmts(varRef("s.0", STRING, loc)),
      ],
      else_: null,
      loc,
    },
    {
      kind: "varDecl",
      localId: "a.0",
      init: {
        kind: "unionNarrow",
        unionId: stdioT.unionId,
        tag: aTag,
        value: sd,
        type: arrayOf(STRING),
        loc,
      },
      loc,
    },
  ];
  const aRef = varRef("a.0", arrayOf(STRING), loc);
  const lenGt: IrExpr = {
    kind: "bin",
    op: "<",
    left: numLit(fd, loc),
    right: { kind: "arrIntrinsic", method: "length", receiver: aRef, args: [], type: F64, loc },
    type: BOOL,
    loc,
  };
  body.push({
    kind: "if",
    cond: { kind: "unary", op: "!", operand: lenGt, type: BOOL, loc },
    then: [{ kind: "return", value: numLit(0, loc), loc }],
    else_: null,
    loc,
  });
  body.push(
    ...modeStmts({ kind: "arrayGet", arr: aRef, index: numLit(fd, loc), type: STRING, loc }),
  );
  lowerer.liftedFns.push({
    name,
    params: [{ localId: "o.0", name: "o", type: optsT }],
    returnType: F64,
    locals,
    body,
    loc,
  });
  return name;
}

/** A runtime stdio SLOT expression whose TYPE is a union of the supported
 * literals (`useStdin ? "pipe" : "ignore"`): the expression evaluates once
 * into a hidden local, and a strEq chain maps the value to its mode (0
 * ignore, 1 inherit, 3 pipe). The type proves the value is one of them; a
 * lying assertion lands on the runtime TypeError Node raises for an
 * invalid stdio value. Null for anything else — the literal and fd paths,
 * and the fences, stay where they are. */
function stdioModeExpr(
  lowerer: Lowerer,
  el: ts.Expression,
  t: ts.Type,
  which: 0 | 1 | 2,
): IrExpr | null {
  const parts = t.isUnionType() ? ts.constituentTypes(t) : [t];
  if (parts.length < 2) return null;
  let hasPipe = false;
  let hasInherit = false;
  let hasIgnore = false;
  for (const part of parts) {
    if (!part.isStringLiteralType()) return null;
    const literal = part.value;
    if (literal === "pipe") hasPipe = true;
    else if (literal === "inherit") hasInherit = true;
    else if (literal === "ignore") hasIgnore = true;
    else return null;
  }
  const slotLoc = locOf(el);
  const value = lowerer.lowerExprExpecting(el, STRING);
  const local = lowerer.declareHiddenLocal(`stdio${which}`, STRING);
  local.mutable = true;
  const read = (): IrExpr => varRef(local.id, STRING, slotLoc);
  const withMode = (name: string, m: number, next: IrExpr): IrExpr => ({
    kind: "ternary",
    cond: {
      kind: "strEq",
      negated: false,
      left: read(),
      right: strLit(name, slotLoc),
      type: BOOL,
      loc: slotLoc,
    },
    then: numLit(m, slotLoc),
    else_: next,
    type: F64,
    loc: slotLoc,
  });
  let mode: IrExpr = nodeThrowExpr(
    1,
    "ERR_INVALID_ARG_VALUE",
    'spawn stdio must be "pipe", "ignore", or "inherit"',
    F64,
    slotLoc,
  );
  if (hasPipe) mode = withMode("pipe", 3, mode);
  if (hasInherit) mode = withMode("inherit", 1, mode);
  if (hasIgnore) mode = withMode("ignore", 0, mode);
  return {
    kind: "seqExpr",
    stmts: [{ kind: "assign", localId: local.id, value, loc: slotLoc }],
    result: mode,
    type: F64,
    loc: slotLoc,
  };
}

/** `spawn(command, args?, options)` → one cp.spawn / cp.spawnOpts
 * libCall. Computed options use native runtime normalization. Inline
 * stdio accepts "ignore", "inherit", or "pipe" as the scalar, or the
 * 3-tuple whose stdin pipe becomes child.stdin, stdout/stderr pipes
 * become child.stdout/child.stderr, and output slots may also be number
 * fds; a 3-tuple slot whose type is a union of those literals
 * (`useStdin ? "pipe" : "ignore"`) evaluates once and maps to its mode
 * at the call. Omitting stdio uses Node's default: all three piped. The
 * other lowered members: `detached` (a boolean literal, inline or carried
 * by the conditional spread `...(c ? { detached: true } : {})` in either
 * orientation — POSIX_SPAWN_SETSID, the child gets its own session and
 * process group like Node's), `env` (a REPLACEMENT environment, the
 * exec-core pairs machinery), `cwd`, and `windowsHide` (a POSIX no-op).
 * The bare `{ stdio: "ignore" }` shape keeps its historical cp.spawn
 * lowering. */
export function lowerSpawnCall(lowerer: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  if (expr.arguments.nodes.length > 3 || expr.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      "spawn with this argument shape",
      expr,
      'the supported form is spawn(command, args?, { stdio: "pipe" | "ignore" | "inherit", detached?, env?, cwd? })',
    );
  }
  const cmd = lowerer.lowerExprExpecting(expr.arguments.nodes[0]!, STRING);
  let argsNode: ts.Expression | undefined;
  let optsNode: ts.Expression | undefined;
  if (expr.arguments.nodes.length === 3) {
    argsNode = expr.arguments.nodes[1];
    optsNode = expr.arguments.nodes[2];
  } else if (expr.arguments.nodes.length === 2) {
    const second = expr.arguments.nodes[1]!;
    const secondType = lowerer.typeOf(second);
    const mapped = lowerer.mapTypeOf(secondType);
    if (
      lowerer.checker.isArrayType(secondType) ||
      lowerer.checker.isTupleType(secondType) ||
      (mapped?.kind === "array" && mapped.elem.kind === "string")
    )
      argsNode = second;
    else optsNode = second;
  }
  if (optsNode !== undefined && !ts.isObjectLiteralExpression(optsNode)) {
    return {
      kind: "libCall",
      fn: "cp.spawnDynamic",
      args: [
        cmd,
        lowerChildArgsArg(lowerer, argsNode, loc),
        lowerer.lowerExprExpecting(optsNode, DYN),
      ],
      type: CHILD_T,
      loc,
    };
  }

  const emptyStr: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
  // Per-slot stdio modes (scr_child.c: 0 ignore, 1 inherit, 2 fd) and
  // the out/err fd expressions for mode 2 (the daemon-log idiom:
  // stdio: ["ignore", logFd, logFd]).
  let sawStdio = false;
  // A slot may be a runtime expression (a union of the three literals), so
  // each mode is an IrExpr: a literal here, the mapped expression there.
  let inMode: IrExpr = numLit(0, loc);
  let outMode: IrExpr = numLit(0, loc);
  let errMode: IrExpr = numLit(0, loc);
  let outFd: IrExpr = numLit(0, loc);
  let errFd: IrExpr = numLit(0, loc);
  let detached: IrExpr = boolLit(false, loc);
  let shell: IrExpr = boolLit(false, loc);
  let shellEnabled = false;
  let hasEnv: IrExpr = boolLit(false, loc);
  let envPairs: IrExpr = { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc };
  let cwd: IrExpr = emptyStr;
  let plain = true; // exactly { stdio: "ignore" }: the historical libCall

  if (optsNode && ts.isObjectLiteralExpression(optsNode)) {
    for (const p of optsNode.properties.nodes) {
      // The conditional-spread idiom `...(isWindows ? {} : { detached:
      // true })` (either orientation): the one carried member supported
      // is `detached` with a boolean literal — the platform-conditional
      // setsid. The condition evaluates at runtime; the empty arm
      // contributes Node's default (false).
      if (ts.isSpreadAssignment(p)) {
        const cs = conditionalSpreadOf(p.expression);
        if (
          cs !== null &&
          cs !== "unsupported" &&
          cs.props.length === 1 &&
          cs.props[0]!.name.text === "detached" &&
          ts.isPropertyAssignment(cs.props[0]!)
        ) {
          const v = (cs.props[0] as ts.PropertyAssignment).initializer;
          const lit =
            v.kind === ts.SyntaxKind.TrueKeyword
              ? true
              : v.kind === ts.SyntaxKind.FalseKeyword
                ? false
                : null;
          if (lit !== null) {
            const cond = lowerer.lowerCondition(cs.cond);
            detached = {
              kind: "ternary",
              cond,
              then: boolLit(cs.whenTrue ? lit : false, loc),
              else_: boolLit(cs.whenTrue ? false : lit, loc),
              type: BOOL,
              loc,
            };
            plain = false;
            continue;
          }
        }
        lowerer.noLowering(
          "spawn with this options spread",
          p,
          "the one supported spread is the conditional `...(c ? { detached: <literal> } : {})` (either orientation) — write other members inline",
        );
      }
      const m = optionMember(p);
      if (!m) {
        lowerer.noLowering(
          "spawn with this options shape",
          p,
          "spreads and computed keys have no lowering — write each member inline",
        );
      }
      switch (m.name) {
        case "stdio": {
          // The 3-tuple form: every slot accepts a literal, including
          // "pipe" (child.stdin/stdout/stderr); stdout/stderr also accept
          // a number-typed fd (an openSync result — dup2'd into the child).
          // A slot EXPRESSION whose type is a union of the three literals
          // (`useStdin ? "pipe" : "ignore"`) evaluates once into a hidden
          // local and maps to its mode at the call.
          if (ts.isArrayLiteralExpression(m.value) && m.value.elements.nodes.length === 3) {
            const slot = (el: ts.Expression, which: 0 | 1 | 2): void => {
              const t = lowerer.typeOf(el);
              if (t.isStringLiteralType()) {
                if (t.value !== "ignore" && t.value !== "inherit" && t.value !== "pipe") {
                  lowerer.noLowering(
                    `spawn with stdio "${t.value}"`,
                    el,
                    '"ignore", "inherit", "pipe", and number output fds are the supported stdio slots',
                  );
                }
                const mode = numLit(t.value === "inherit" ? 1 : t.value === "pipe" ? 3 : 0, loc);
                if (which === 0) inMode = mode;
                else if (which === 1) outMode = mode;
                else errMode = mode;
                if (t.value === "pipe") plain = false;
                return;
              }
              const runtimeMode = stdioModeExpr(lowerer, el, t, which);
              if (runtimeMode) {
                if (which === 0) inMode = runtimeMode;
                else if (which === 1) outMode = runtimeMode;
                else errMode = runtimeMode;
                plain = false;
                return;
              }
              if (which === 0) {
                lowerer.noLowering(
                  "spawn with this stdin slot",
                  el,
                  'stdin takes "pipe", "ignore", or "inherit" (fd stdin has no lowering)',
                );
              }
              if (lowerer.mapTypeOf(t)?.kind !== "f64") {
                lowerer.noLowering(
                  "spawn with this stdio option",
                  el,
                  'each slot is "ignore", "inherit", or a number fd (an openSync result)',
                );
              }
              const fd = lowerer.lowerExprExpecting(el, F64);
              if (which === 1) {
                outMode = numLit(2, loc);
                outFd = fd;
              } else {
                errMode = numLit(2, loc);
                errFd = fd;
              }
            };
            m.value.elements.nodes.forEach((el, i) => slot(el, i as 0 | 1 | 2));
            sawStdio = true;
            plain = false;
            break;
          }
          const t = lowerer.typeOf(m.value);
          const v = t.isStringLiteralType() ? t.value : null;
          if (v !== "pipe" && v !== "ignore" && v !== "inherit") {
            lowerer.noLowering(
              "spawn with this stdio option",
              m.value,
              '"pipe", "ignore", and "inherit" are the supported stdio literals ' +
                "(or a 3-tuple of those and number output fds)",
            );
          }
          const mode = numLit(v === "inherit" ? 1 : v === "pipe" ? 3 : 0, loc);
          inMode = outMode = errMode = mode;
          sawStdio = true;
          if (v !== "ignore") plain = false;
          break;
        }
        case "detached": {
          if (m.value.kind === ts.SyntaxKind.TrueKeyword) {
            detached = boolLit(true, loc);
            plain = false;
          } else if (m.value.kind === ts.SyntaxKind.FalseKeyword) {
            detached = boolLit(false, loc);
          } else {
            // A runtime boolean — the portable daemon idiom `detached:
            // process.platform !== "win32"` — reaches the same
            // POSIX_SPAWN_SETSID flag through scr_spawn_opts's bool slot.
            detached = lowerer.lowerExprExpecting(m.value, BOOL);
            plain = false;
          }
          break;
        }
        case "env":
          hasEnv = boolLit(true, loc);
          envPairs = recordToEnvPairs(lowerer, m.value);
          plain = false;
          break;
        case "cwd":
          cwd = lowerer.lowerExprExpecting(m.value, STRING);
          plain = false;
          break;
        case "windowsHide":
          lowerer.lowerExpr(m.value); // Node no-op on POSIX
          break;
        case "shell":
          if (m.value.kind === ts.SyntaxKind.TrueKeyword) {
            shell = boolLit(true, loc);
            shellEnabled = true;
            plain = false;
          } else if (m.value.kind === ts.SyntaxKind.FalseKeyword) {
            shell = boolLit(false, loc);
          } else {
            lowerer.noLowering(
              "spawn with a non-literal shell option",
              m.value,
              "shell must be a boolean literal",
            );
          }
          break;
        default:
          lowerer.noLowering(
            `spawn option '${m.name}'`,
            p,
            "stdio, detached, env, cwd, windowsHide, and shell are the supported options",
          );
      }
    }
  }
  if (!sawStdio) {
    inMode = outMode = errMode = numLit(3, loc);
    plain = false;
  }
  // Node joins [command, ...args] with single spaces for the shell form, and
  // reports DEP0190 ("passing args to a child process with shell option
  // true ... the arguments are not escaped, only concatenated") on stderr.
  // A native build has no warning channel, so it refuses the form rather
  // than silently skipping the warning Node prints.
  if (shellEnabled && !staticallyEmptyArgs(argsNode)) {
    lowerer.noLowering(
      "spawn with shell enabled and separate arguments",
      argsNode ?? expr,
      "put the complete shell command in the first argument and pass [] (Node warns DEP0190 for unescaped shell arguments, and a native build cannot report that warning)",
    );
  }
  const argv = lowerChildArgsArg(lowerer, argsNode, loc);
  if (plain) {
    return { kind: "libCall", fn: "cp.spawn", args: [cmd, argv], type: CHILD_T, loc };
  }
  return {
    kind: "libCall",
    fn: "cp.spawnOpts",
    args: [
      cmd,
      argv,
      inMode,
      outMode,
      errMode,
      outFd,
      errFd,
      detached,
      shell,
      hasEnv,
      envPairs,
      cwd,
    ],
    type: CHILD_T,
    loc,
  };
}

/** `fork(staticModulePath, args?, options?)` embeds the selected program
 * module and re-executes the native artifact with one private target id.
 * Node's default JSON IPC channel is always present. */
export function lowerForkCall(lowerer: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  if (
    expr.arguments.nodes.length < 1 ||
    expr.arguments.nodes.length > 3 ||
    expr.arguments.nodes.some(ts.isSpreadElement)
  ) {
    lowerer.noLowering(
      "fork with this argument shape",
      expr,
      "use fork(staticModulePath[, stringArgs][, inlineOptions])",
    );
  }
  const targetPath = staticForkModulePath(lowerer.program, expr.arguments.nodes[0]!);
  const targetId =
    targetPath === null ? undefined : lowerer.forkTargetIdByPath.get(tsgoPath(resolve(targetPath)));
  if (targetId === undefined) {
    lowerer.noLowering(
      "fork with a runtime-valued module path",
      expr.arguments.nodes[0]!,
      'resolve a relative worker with new URL("./worker.ts", import.meta.url) or fileURLToPath(...) and bind it to a const if needed',
    );
  }

  let argsNode: ts.Expression | undefined;
  let optsNode: ts.Expression | undefined;
  if (expr.arguments.nodes.length === 3) {
    argsNode = expr.arguments.nodes[1];
    optsNode = expr.arguments.nodes[2];
  } else if (expr.arguments.nodes.length === 2) {
    const second = expr.arguments.nodes[1]!;
    const secondType = lowerer.typeOf(second);
    const mapped = lowerer.mapTypeOf(secondType);
    if (
      lowerer.checker.isArrayType(secondType) ||
      lowerer.checker.isTupleType(secondType) ||
      (mapped?.kind === "array" && mapped.elem.kind === "string")
    ) {
      argsNode = second;
    } else {
      optsNode = second;
    }
  }
  if (optsNode !== undefined && !ts.isObjectLiteralExpression(optsNode)) {
    lowerer.noLowering(
      "fork with a non-literal options argument",
      optsNode,
      "pass cwd, env, execArgv, silent, stdio, serialization, and windowsHide in an inline object literal",
    );
  }

  let inMode = 1;
  let outMode = 1;
  let errMode = 1;
  let sawStdio = false;
  let silent = false;
  let hasEnv: IrExpr = boolLit(false, loc);
  let envPairs: IrExpr = { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc };
  let cwd: IrExpr = { kind: "strLit", value: "", type: STRING, loc };

  const stdioMode = (node: ts.Expression, label: string): number => {
    const type = lowerer.typeOf(node);
    const value = type.isStringLiteralType() ? type.value : null;
    if (value !== "ignore" && value !== "inherit" && value !== "pipe") {
      lowerer.noLowering(
        `fork with ${label} stdio`,
        node,
        '"ignore", "inherit", and "pipe" are the supported stdio modes',
      );
    }
    return value === "ignore" ? 0 : value === "inherit" ? 1 : 3;
  };

  if (optsNode && ts.isObjectLiteralExpression(optsNode)) {
    for (const property of optsNode.properties.nodes) {
      const member = optionMember(property);
      if (!member) {
        lowerer.noLowering(
          "fork with this options shape",
          property,
          "spreads and computed keys have no lowering — write each member inline",
        );
      }
      switch (member.name) {
        case "cwd":
          cwd = lowerer.lowerExprExpecting(member.value, STRING);
          break;
        case "env":
          hasEnv = boolLit(true, loc);
          envPairs = recordToEnvPairs(lowerer, member.value);
          break;
        case "silent":
          if (member.value.kind === ts.SyntaxKind.TrueKeyword) silent = true;
          else if (member.value.kind !== ts.SyntaxKind.FalseKeyword) {
            lowerer.noLowering(
              "fork with a non-literal silent option",
              member.value,
              "silent must be a boolean literal",
            );
          }
          break;
        case "stdio": {
          if (ts.isArrayLiteralExpression(member.value)) {
            if (member.value.elements.nodes.length !== 4) {
              lowerer.noLowering(
                "fork with this stdio tuple",
                member.value,
                'use [stdin, stdout, stderr, "ipc"] with exactly four literal entries',
              );
            }
            const ipc = member.value.elements.nodes[3]!;
            const ipcType = lowerer.typeOf(ipc);
            if (!ipcType.isStringLiteralType() || ipcType.value !== "ipc") {
              lowerer.noLowering(
                "fork without a fourth-slot IPC channel",
                ipc,
                'the fourth stdio entry must be "ipc"',
              );
            }
            inMode = stdioMode(member.value.elements.nodes[0]!, "stdin");
            outMode = stdioMode(member.value.elements.nodes[1]!, "stdout");
            errMode = stdioMode(member.value.elements.nodes[2]!, "stderr");
          } else {
            const mode = stdioMode(member.value, "scalar");
            inMode = outMode = errMode = mode;
          }
          sawStdio = true;
          break;
        }
        case "serialization": {
          const type = lowerer.typeOf(member.value);
          if (!type.isStringLiteralType() || type.value !== "json") {
            lowerer.noLowering(
              "fork with non-JSON serialization",
              member.value,
              'the static IPC channel supports Node\'s default serialization or serialization: "json"',
            );
          }
          break;
        }
        case "execArgv":
          // Loader flags configure the Node executable. The native worker is
          // already compiled into this artifact, so no loader starts.
          break;
        case "windowsHide":
          lowerer.lowerExpr(member.value); // accepted platform presentation option
          break;
        default:
          lowerer.noLowering(
            `fork with the '${member.name}' option`,
            member.value,
            "cwd, env, execArgv, silent, stdio, serialization, and windowsHide are supported",
          );
      }
    }
  }
  if (!sawStdio && silent) inMode = outMode = errMode = 3;

  return {
    kind: "libCall",
    fn: "cp.fork",
    args: [
      numLit(targetId, loc),
      lowerChildArgsArg(lowerer, argsNode, loc),
      numLit(inMode, loc),
      numLit(outMode, loc),
      numLit(errMode, loc),
      hasEnv,
      envPairs,
      cwd,
    ],
    type: CHILD_T,
    loc,
  };
}

/** `execFile(file[, args][, options], callback)` — the asynchronous callback
 * slice. With `shell`, `exec(command[, options], callback)`: the command
 * line runs with /bin/sh -c, as execSync runs it, and failure messages show
 * the command line as Node's do. The child starts immediately with
 * stdin/stdout/stderr piped; the runtime captures both outputs and invokes
 * the error-first callback after settlement. The callback may ignore a suffix of `(error, stdout,
 * stderr)`, but every declared parameter must have the Node shape. Inline
 * `encoding: "utf8"` and a pure numeric `maxBuffer` are accepted; the latter
 * is not enforced by the growing native capture, as
 * with the synchronous and promisified capture forms. Other options remain
 * fenced until their lifecycle can share this asynchronous core. */
export function lowerExecFileCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
  shell = false,
): IrExpr {
  const what = shell ? "exec" : "execFile";
  if (
    expr.arguments.nodes.some(ts.isSpreadElement) ||
    expr.arguments.nodes.length < 2 ||
    expr.arguments.nodes.length > (shell ? 3 : 4)
  ) {
    lowerer.noLowering(
      `${what} with ${expr.arguments.nodes.length} arguments`,
      expr,
      shell
        ? "the supported callback forms are exec(command, callback) and exec(command, { encoding: 'utf8', maxBuffer: N }, callback)"
        : "the supported callback forms are execFile(file, callback), execFile(file, args, callback), and execFile(file, args, { encoding: 'utf8', maxBuffer: N }, callback)",
    );
  }
  const first = lowerer.lowerExprExpecting(expr.arguments.nodes[0]!, STRING);
  const callbackNode = expr.arguments.nodes[expr.arguments.nodes.length - 1]!;
  // exec already IS the shell form: /bin/sh -c <command>, execSync's
  // lowering (the runtime reads the command line back from argv[1] for
  // failure messages). execFile's `shell: true` below turns it into the
  // same shape, so the launch values are final only after the options.
  let execShell = false;
  // `cwd` (the SCR_CHILD_CP_OPTIONS build): the child's directory, the
  // one launch member the callback slice lacked.
  let cwd: IrExpr | null = null;
  const optionsNode =
    expr.arguments.nodes.length === (shell ? 3 : 4)
      ? expr.arguments.nodes[shell ? 1 : 2]
      : undefined;
  if (optionsNode) {
    const options = optionsNode;
    if (!ts.isObjectLiteralExpression(options)) {
      lowerer.noLowering(
        `${what} with a non-literal options argument`,
        options,
        "pass encoding and maxBuffer in an inline object literal",
      );
    }
    const pureNumber = (node: ts.Expression): boolean =>
      ts.isNumericLiteral(node) ||
      (ts.isParenthesizedExpression(node) && pureNumber(node.expression)) ||
      (ts.isBinaryExpression(node) &&
        [
          ts.SyntaxKind.PlusToken,
          ts.SyntaxKind.MinusToken,
          ts.SyntaxKind.AsteriskToken,
          ts.SyntaxKind.SlashToken,
        ].includes(node.operatorToken.kind) &&
        pureNumber(node.left) &&
        pureNumber(node.right));
    for (const property of options.properties.nodes) {
      const member = optionMember(property);
      if (!member)
        lowerer.noLowering(
          `${what} with this options shape`,
          property,
          "use plain encoding and maxBuffer properties without spreads or computed keys",
        );
      if (member.name === "encoding") {
        if (
          !ts.isStringLiteral(member.value) ||
          (member.value.text !== "utf8" && member.value.text !== "utf-8")
        ) {
          lowerer.noLowering(
            `${what} with a non-literal utf8 encoding`,
            member.value,
            "pass the literal 'utf8' or 'utf-8' (other expressions might have side effects)",
          );
        }
      } else if (member.name === "maxBuffer") {
        if (!pureNumber(member.value)) {
          lowerer.noLowering(
            `${what} with a non-literal maxBuffer`,
            member.value,
            "pass a numeric literal or literal arithmetic (the native capture grows without enforcing this limit)",
          );
        }
      } else if (member.name === "cwd") {
        cwd = lowerer.lowerExprExpecting(member.value, STRING);
      } else if (member.name === "shell" && !shell) {
        // Node's shell form: [file, ...args].join(" ") through /bin/sh -c.
        // exec itself already IS the shell form, so its member stays out.
        if (member.value.kind === ts.SyntaxKind.TrueKeyword) execShell = true;
        else if (member.value.kind !== ts.SyntaxKind.FalseKeyword) {
          lowerer.noLowering(
            `${what} with a non-literal shell option`,
            member.value,
            "shell must be a boolean literal",
          );
        }
      } else {
        lowerer.noLowering(
          `${what} option '${member.name}'`,
          property,
          "encoding: 'utf8', a pure numeric maxBuffer, cwd, and shell: true are the supported options in the callback form",
        );
      }
    }
  }
  // The launch values, final now that `shell: true` is known.
  const shellForm = shell || execShell;
  const cmd: IrExpr = shellForm ? { kind: "strLit", value: "/bin/sh", type: STRING, loc } : first;
  // Node joins [file, ...args] with single spaces for the shell form and
  // reports DEP0190 on stderr; a native build has no warning channel, so it
  // refuses separate arguments here rather than silently skipping it.
  if (
    execShell &&
    !staticallyEmptyArgs(expr.arguments.nodes.length >= 3 ? expr.arguments.nodes[1] : undefined)
  ) {
    lowerer.noLowering(
      `${what} with shell enabled and separate arguments`,
      expr.arguments.nodes[1]!,
      "put the complete shell command in the first argument and pass [] (Node warns DEP0190 for unescaped shell arguments, and a native build cannot report that warning)",
    );
  }
  let argv: IrExpr;
  if (shellForm) {
    argv = {
      kind: "arrayLit",
      elems: [{ kind: "strLit", value: "-c", type: STRING, loc }, first],
      type: arrayOf(STRING),
      loc,
    };
  } else {
    argv = lowerChildArgsArg(
      lowerer,
      expr.arguments.nodes.length >= 3 ? expr.arguments.nodes[1] : undefined,
      loc,
    );
  }
  const callback = lowerer.lowerExpr(callbackNode);
  if (
    callback.type.kind !== "func" ||
    callback.type.rest === true ||
    callback.type.params.length > 3
  ) {
    lowerer.unsupported(
      "SC1090",
      callbackNode,
      `${what} callbacks take (error), (error, stdout), (error, stdout, stderr), or no parameters`,
    );
  }
  if (callback.type.ret.kind !== "void") {
    lowerer.unsupported(
      "SC1090",
      callbackNode,
      `${what} callbacks returning a value (make the callback body a block, or return nothing)`,
    );
  }
  const errorParam = callback.type.params[0];
  if (errorParam !== undefined) {
    const def = errorParam.kind === "union" ? lowerer.unions.get(errorParam.unionId) : undefined;
    const valid =
      !!def &&
      def.arms.length === 2 &&
      def.arms.some((arm) => arm.kind === "nullT") &&
      def.arms.some((arm) => arm.kind === "object" && arm.className === "%Error");
    if (!valid) {
      lowerer.unsupported(
        "SC1090",
        callbackNode,
        `${what} callbacks whose first parameter is not 'Error | null' (got '${lowerer.fmt(errorParam)}')`,
      );
    }
  }
  for (let i = 1; i < callback.type.params.length; i++) {
    if (callback.type.params[i]!.kind !== "string") {
      lowerer.unsupported(
        "SC1090",
        callbackNode,
        `${what} callbacks whose ${i === 1 ? "stdout" : "stderr"} parameter is not 'string'`,
      );
    }
  }
  if (cwd !== null) {
    return {
      kind: "libCall",
      fn: "cp.execFileCwd",
      args: [cmd, argv, callback, boolLit(shellForm, loc), cwd],
      type: CHILD_T,
      loc,
    };
  }
  return {
    kind: "libCall",
    fn: "cp.execFile",
    args: [cmd, argv, callback, boolLit(shellForm, loc)],
    type: CHILD_T,
    loc,
  };
}
