import { keyedHelperName } from "../stable-names.js";
import { recordToEnvPairs } from "./environment.js";
import { lowerChildArgsArg } from "./child-process.js";
import { boolLit, numLit, varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { conditionalSpreadOf } from "../expressions/object-literals.js";
import {
  BOOL,
  F64,
  type IrExpr,
  type IrStmt,
  type IrType,
  SPAWNRES_T,
  STRING,
  type SrcLoc,
  arrayOf,
} from "../../../ir/ir.js";
import { optionMember } from "./arguments.js";
import { execResultShape } from "../../type-mapper.js";

/** A call THROUGH a promisified-execFile binding:
 * `execFileAsync(file, args?, options?)` → one call of the interned
 * %execFileAsync helper (with `shell`, a promisified-exec binding:
 * `execAsync(command, options?)` → %execAsync, the command line run by
 * /bin/sh -c as execSync runs it) — an ASYNC IR function (a throw
 * becomes a rejection automatically) that runs the exec core
 * synchronously and returns `{ stdout, stderr }`, exactly Node's
 * promisified execFile/exec behind an already-settled promise (the
 * fs/promises stance, divergence 23). Options are the exec-sync slice minus stdio (the async form always
 * captures both streams, no echo): encoding must spell utf8, cwd/env/
 * timeout lower, maxBuffer/windowsHide are accepted no-ops, killSignal
 * only as its SIGTERM default. Rejections carry Node's async messages
 * ("Command failed: <cmd>\n<stderr>" — the trailing newline is Node's —
 * and "spawn <file> ENOENT" with .code); Node's numeric `.code` on a
 * Command-failed rejection (the exit status) is NOT carried —
 * SEMANTICS.md divergence 50's stance. */
export function lowerExecFileAsyncCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
  shell = false,
): IrExpr {
  const what = shell ? "the promisified exec" : "the promisified execFile";
  if (
    expr.arguments.nodes.length < 1 ||
    expr.arguments.nodes.length > (shell ? 2 : 3) ||
    expr.arguments.nodes.some(ts.isSpreadElement)
  ) {
    lowerer.noLowering(
      `${what} with this argument shape`,
      expr,
      shell
        ? "the supported form is execAsync(command, options?)"
        : "the supported form is execFileAsync(file, args?, options?)",
    );
  }
  const command = lowerer.lowerExprExpecting(expr.arguments.nodes[0]!, STRING);
  // exec: /bin/sh -c <command>, execSync's lowering (the command string
  // rides as the argv[1] the failure display reads); execFile: file + its
  // args list.
  const cmd: IrExpr = shell ? { kind: "strLit", value: "/bin/sh", type: STRING, loc } : command;
  const argv: IrExpr = shell
    ? {
        kind: "arrayLit",
        elems: [{ kind: "strLit", value: "-c", type: STRING, loc }, command],
        type: arrayOf(STRING),
        loc,
      }
    : lowerChildArgsArg(lowerer, expr.arguments.nodes[1], loc);
  const optsNode = expr.arguments.nodes[shell ? 1 : 2];

  const emptyStr: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
  const helper = execFileAsyncHelper(lowerer, loc, shell);
  const envRecT: IrType = { kind: "record", shapeId: helper.envShapeId };
  const envRec = (has: boolean, pairs: IrExpr): IrExpr => ({
    kind: "recordLit",
    fields: [
      { name: "has", value: boolLit(has, loc) },
      { name: "pairs", value: pairs },
    ],
    type: envRecT,
    loc,
  });
  const emptyPairs = (): IrExpr => ({ kind: "arrayLit", elems: [], type: arrayOf(STRING), loc });
  let cwd: IrExpr = emptyStr;
  let env: IrExpr = envRec(false, emptyPairs());
  let timeout: IrExpr = numLit(0, loc);
  if (optsNode) {
    if (!ts.isObjectLiteralExpression(optsNode)) {
      lowerer.noLowering(
        `${what} with a non-literal options argument`,
        optsNode,
        "pass the options inline so each member can be checked",
      );
    }
    for (const p of optsNode.properties.nodes) {
      // The conditional-spread idiom carrying `env` — the portless
      // opensslAsync shape: `...(c ? { env: { ...process.env, ...extra
      // } } : {})` (either orientation). The condition evaluates ONCE
      // and picks between the has-env record (whose pairs build lazily
      // in that arm — tsc's narrowing of the condition holds there) and
      // the inherit-parent default, exactly the spread's semantics.
      if (ts.isSpreadAssignment(p)) {
        const cs = conditionalSpreadOf(p.expression);
        if (
          cs !== null &&
          cs !== "unsupported" &&
          cs.props.length === 1 &&
          cs.props[0]!.name.text === "env" &&
          ts.isPropertyAssignment(cs.props[0]!)
        ) {
          const cond = lowerer.lowerCondition(cs.cond);
          const carried = envRec(
            true,
            recordToEnvPairs(lowerer, (cs.props[0] as ts.PropertyAssignment).initializer),
          );
          const absent = envRec(false, emptyPairs());
          env = {
            kind: "ternary",
            cond,
            then: cs.whenTrue ? carried : absent,
            else_: cs.whenTrue ? absent : carried,
            type: envRecT,
            loc,
          };
          continue;
        }
        lowerer.noLowering(
          `${what} with this options spread`,
          p,
          "the one supported spread is the conditional `...(c ? { env: ... } : {})` (either orientation) — write other members inline",
        );
      }
      const m = optionMember(p);
      if (!m) {
        lowerer.noLowering(
          `${what} with this options shape`,
          p,
          "spreads and computed keys have no lowering — write each member inline",
        );
      }
      switch (m.name) {
        case "encoding": {
          const t = lowerer.typeOf(m.value);
          if (!t.isStringLiteralType() || (t.value !== "utf8" && t.value !== "utf-8")) {
            lowerer.noLowering(
              `${what} with a non-utf8 encoding`,
              m.value,
              'outputs are captured as utf8 — pass { encoding: "utf8" } (Node\'s own default here)',
            );
          }
          break;
        }
        case "cwd":
          cwd = lowerer.lowerExprExpecting(m.value, STRING);
          break;
        case "env":
          env = envRec(true, recordToEnvPairs(lowerer, m.value));
          break;
        case "timeout":
          timeout = lowerer.lowerExprExpecting(m.value, F64);
          break;
        case "maxBuffer":
          lowerer.lowerExpr(m.value); // accepted, not enforced (divergence 50)
          break;
        case "windowsHide":
          lowerer.lowerExpr(m.value); // Node no-op on POSIX
          break;
        case "killSignal": {
          const t = lowerer.typeOf(m.value);
          if (!t.isStringLiteralType() || t.value !== "SIGTERM") {
            lowerer.noLowering(
              `${what} with a non-default killSignal`,
              m.value,
              "only the SIGTERM default is implemented for the timeout kill",
            );
          }
          break;
        }
        default:
          lowerer.noLowering(
            `${what} option '${m.name}'`,
            p,
            "encoding, cwd, env, timeout, and maxBuffer are the supported options",
          );
      }
    }
  }
  return {
    kind: "call",
    callee: helper.name,
    args: [cmd, argv, cwd, env, timeout],
    type: { kind: "promise", inner: { kind: "record", shapeId: helper.shapeId } },
    loc,
  };
}

/** The interned `%execFileAsync` helper behind promisified-execFile
 * calls (`%execAsync`, with `shell`, behind promisified-exec ones): an
 * ASYNC IR function (params: cmd, argv, cwd, env {has, pairs}, timeoutMs)
 * whose body runs the may-throw cp.execCapture libCall — the async
 * machinery turns a throw into the rejection, Node's promisified
 * behavior — and returns the `{ stdout, stderr }` record built from the
 * capture. One helper per program and form (the shape is fixed). */
function execFileAsyncHelper(
  lowerer: Lowerer,
  loc: SrcLoc,
  shell: boolean,
): { name: string; shapeId: string; envShapeId: string } {
  const shapeId = execResultShape(lowerer.shapes);
  // The env choice travels as ONE {has, pairs} record so a conditional
  // env spread's condition evaluates exactly once at the call site (has
  // and pairs both derive from it).
  const envShapeId = lowerer.shapes.intern([
    { name: "has", type: BOOL },
    { name: "pairs", type: arrayOf(STRING) },
  ]);
  const key = shell ? "execAsync" : "execFileAsync";
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return { name: existing, shapeId, envShapeId };
  const name = keyedHelperName(lowerer, `%${key}`, key);
  lowerer.valueHelpers.set(key, name);
  const recT: IrType = { kind: "record", shapeId };
  const envRecT: IrType = { kind: "record", shapeId: envShapeId };
  const strArrT = arrayOf(STRING);

  const body: IrStmt[] = [
    {
      kind: "varDecl",
      localId: "r.0",
      init: {
        kind: "libCall",
        fn: "cp.execCapture",
        args: [
          varRef("cmd.0", STRING, loc),
          varRef("argv.0", strArrT, loc),
          boolLit(shell, loc),
          varRef("cwd.0", STRING, loc),
          {
            kind: "recordGet",
            obj: varRef("env.0", envRecT, loc),
            shapeId: envShapeId,
            field: "has",
            type: BOOL,
            loc,
          },
          {
            kind: "recordGet",
            obj: varRef("env.0", envRecT, loc),
            shapeId: envShapeId,
            field: "pairs",
            type: strArrT,
            loc,
          },
          varRef("timeout.0", F64, loc),
        ],
        type: SPAWNRES_T,
        loc,
      },
      loc,
    },
    {
      kind: "return",
      value: {
        kind: "recordLit",
        fields: [
          {
            name: "stderr",
            value: {
              kind: "libCall",
              fn: "spawnRes.stderr",
              args: [varRef("r.0", SPAWNRES_T, loc)],
              type: STRING,
              loc,
            },
          },
          {
            name: "stdout",
            value: {
              kind: "libCall",
              fn: "spawnRes.stdout",
              args: [varRef("r.0", SPAWNRES_T, loc)],
              type: STRING,
              loc,
            },
          },
        ],
        type: recT,
        loc,
      },
      loc,
    },
  ];
  lowerer.liftedFns.push({
    name,
    params: [
      { localId: "cmd.0", name: "cmd", type: STRING },
      { localId: "argv.0", name: "argv", type: strArrT },
      { localId: "cwd.0", name: "cwd", type: STRING },
      { localId: "env.0", name: "env", type: envRecT },
      { localId: "timeout.0", name: "timeout", type: F64 },
    ],
    returnType: recT,
    async: true,
    locals: [
      { id: "cmd.0", name: "cmd", type: STRING, mutable: false },
      { id: "argv.0", name: "argv", type: strArrT, mutable: false },
      { id: "cwd.0", name: "cwd", type: STRING, mutable: false },
      { id: "env.0", name: "env", type: envRecT, mutable: false },
      { id: "timeout.0", name: "timeout", type: F64, mutable: false },
      { id: "r.0", name: "r", type: SPAWNRES_T, mutable: false },
    ],
    body,
    loc,
  });
  return { name, shapeId, envShapeId };
}
