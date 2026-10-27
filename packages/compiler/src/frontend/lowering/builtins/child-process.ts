import { recordToEnvPairs } from "./environment.js";
import { boolLit, numLit } from "../../../ir/build.js";
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
  SPAWNRES_T,
  STRING,
  type SrcLoc,
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
 * stance), and `windowsHide` (a POSIX no-op, evaluated for side
 * effects). Everything else (shell, cwd, env, input, maxBuffer, ...)
 * fences by name. The bare `{ encoding: "utf8" }` shape keeps its
 * historical cp.spawnSync lowering. */
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
  // A RUNTIME stdio string (the defaultRunner idiom: `options?.stdio ??
  // "pipe"`) — accepted when its TYPE proves every arm is a supported
  // literal; the runtime maps the value to the modes at the call.
  let stdioStr: IrExpr | null = null;
  // The `env` option's [k,v,...] pairs, which replace the child's environment.
  let envPairs: IrExpr | null = null;
  let plain = true; // no behavior-changing option: the historical libCall

  if (optsNode) {
    if (!ts.isObjectLiteralExpression(optsNode)) {
      lowerer.noLowering(
        "spawnSync with a non-literal options argument",
        optsNode,
        "pass the options inline so each member can be checked",
      );
    }
    const applyStdio = (node: ts.Expression): void => {
      const modeOf = (v: string, fd: 0 | 1 | 2): void => {
        if (v === "pipe") return; // the default modes
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
          plain = false;
          break;
        default:
          lowerer.noLowering(
            `spawnSync option '${m.name}'`,
            p,
            "encoding, timeout, killSignal, stdio, env, and windowsHide are the supported options",
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
    return {
      kind: "libCall",
      fn: "cp.spawnSyncStdioStr",
      args: [cmd, argv, timeout, killSignal, stdioStr],
      type: SPAWNRES_T,
      loc,
    };
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

/** `spawn(command, args?, options)` → one cp.spawn / cp.spawnOpts
 * libCall. Computed options use native runtime normalization. Inline
 * stdio accepts "ignore", "inherit", or "pipe" as the scalar,
 * or the 3-tuple whose stdin pipe becomes child.stdin, stdout/stderr
 * pipes become child.stdout/child.stderr, and output slots may also be
 * number fds. Omitting stdio uses Node's default: all three piped. The
 * other lowered
 * members: `detached` (a boolean literal, inline or carried by the
 * conditional spread `...(c ? { detached: true } : {})` in either
 * orientation — POSIX_SPAWN_SETSID, the child gets its own session and
 * process group like Node's), `env` (a
 * REPLACEMENT environment, the exec-core pairs machinery), `cwd`, and
 * `windowsHide` (a POSIX no-op). The bare `{ stdio: "ignore" }` shape
 * keeps its historical cp.spawn lowering. */
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
  let inMode = 0,
    outMode = 0,
    errMode = 0;
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
                const mode = t.value === "inherit" ? 1 : t.value === "pipe" ? 3 : 0;
                if (which === 0) inMode = mode;
                else if (which === 1) outMode = mode;
                else errMode = mode;
                if (t.value === "pipe") plain = false;
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
                outMode = 2;
                outFd = fd;
              } else {
                errMode = 2;
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
          const mode = v === "inherit" ? 1 : v === "pipe" ? 3 : 0;
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
            lowerer.noLowering(
              "spawn with a non-literal detached option",
              m.value,
              "detached must be a boolean literal",
            );
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
    inMode = outMode = errMode = 3;
    plain = false;
  }
  if (shellEnabled && argsNode !== undefined) {
    const shellArgs = stripTypeCasts(argsNode);
    if (!ts.isArrayLiteralExpression(shellArgs) || shellArgs.elements.nodes.length !== 0) {
      lowerer.noLowering(
        "spawn with shell enabled and separate arguments",
        argsNode,
        "put the complete shell command in the first argument and pass [] (Node deprecates unescaped shell argument concatenation)",
      );
    }
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
      numLit(inMode, loc),
      numLit(outMode, loc),
      numLit(errMode, loc),
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
  // exec: /bin/sh -c <command>, execSync's lowering (the runtime reads the
  // command line back from argv[1] for failure messages); execFile: the
  // file and its args list.
  const cmd: IrExpr = shell ? { kind: "strLit", value: "/bin/sh", type: STRING, loc } : first;
  const argv: IrExpr = shell
    ? {
        kind: "arrayLit",
        elems: [{ kind: "strLit", value: "-c", type: STRING, loc }, first],
        type: arrayOf(STRING),
        loc,
      }
    : lowerChildArgsArg(
        lowerer,
        expr.arguments.nodes.length >= 3 ? expr.arguments.nodes[1] : undefined,
        loc,
      );
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
      } else {
        lowerer.noLowering(
          `${what} option '${member.name}'`,
          property,
          "only encoding: 'utf8' and a pure numeric maxBuffer are supported in the callback form",
        );
      }
    }
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
  return {
    kind: "libCall",
    fn: "cp.execFile",
    args: [cmd, argv, callback, boolLit(shell, loc)],
    type: CHILD_T,
    loc,
  };
}
