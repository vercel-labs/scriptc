import { keyedHelperName } from "../stable-names.js";
import { recordToEnvPairs } from "./environment.js";
import { lowerChildArgsArg } from "./child-process.js";
import { boolLit, numLit, strLit, varRef } from "../../../ir/build.js";
import { InternalCompilerError } from "../../../errors.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { conditionalSpreadOf } from "../expressions/object-literals.js";
import {
  BOOL,
  F64,
  type IrExpr,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  arrayOf,
} from "../../../ir/ir.js";
import { optionMember } from "./arguments.js";

/** `execFileSync(file, args?, options?)` / `execSync(command, options?)`
 * → the ONE cp.execSync libCall. execSync wraps the command in
 * `/bin/sh -c` (Node's shell semantics — a single command string, no
 * args array); execFileSync runs the file directly with its args. The
 * options object, when present, must be an object LITERAL whose members
 * are drawn from the honestly-implemented set — `encoding` (must be the
 * "utf8"/"utf-8" literal, like spawnSync — outputs are captured utf8),
 * `cwd`, `env`, `input`, `timeout`, `stdio` (the "pipe"/"ignore"
 * string form or a 3-tuple of those), `maxBuffer` (accepted, not
 * enforced — the capture grows), `killSignal` (accepted only as the
 * SIGTERM default), `windowsHide`/`shell:false` on execFileSync (Node
 * no-ops here). Every other member (a non-default killSignal, shell:true
 * on execFileSync, ...) fences by name. */
/** Side-effect-free read shapes — identifiers and (optional) property
 * access chains over them (`options?.input`) — the shapes a lowering may
 * evaluate more than once (the readOpt re-read discipline). */
function isPureReadShape(e: ts.Expression): boolean {
  if (ts.isIdentifier(e) || e.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isPropertyAccessExpression(e)) return isPureReadShape(e.expression);
  if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e))
    return isPureReadShape(e.expression);
  return false;
}

export function lowerExecSyncCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  shell: boolean,
  loc: SrcLoc,
): IrExpr {
  if (expr.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(`${shell ? "execSync" : "execFileSync"} with a spread call`, expr);
  }
  const cmd = lowerer.lowerExprExpecting(expr.arguments.nodes[0]!, STRING);
  // execSync: /bin/sh -c <command>; execFileSync: file + its args list.
  let argvExpr: IrExpr;
  let optsNode: ts.Expression | undefined;
  if (shell) {
    if (expr.arguments.nodes.length > 2) {
      lowerer.noLowering(
        "execSync with this argument shape",
        expr,
        "the supported form is execSync(command, options?)",
      );
    }
    argvExpr = {
      kind: "arrayLit",
      elems: [{ kind: "strLit", value: "-c", type: STRING, loc }, cmd],
      type: arrayOf(STRING),
      loc,
    };
    optsNode = expr.arguments.nodes[1];
  } else {
    if (expr.arguments.nodes.length > 3) {
      lowerer.noLowering(
        "execFileSync with this argument shape",
        expr,
        "the supported form is execFileSync(file, args?, options?)",
      );
    }
    argvExpr = lowerChildArgsArg(lowerer, expr.arguments.nodes[1], loc);
    optsNode = expr.arguments.nodes[2];
  }
  // The shell command itself is /bin/sh; the "command" string rides as
  // the argv[1] the display formatter reads.
  const cmdArg: IrExpr = shell ? { kind: "strLit", value: "/bin/sh", type: STRING, loc } : cmd;

  const emptyStr: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
  const emptyPairs: IrExpr = { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc };

  // Defaults: no shell input, inherit cwd/env, no timeout, capture
  // stdout (mode 1), capture+echo stderr (mode 0 — Node's inheritStderr).
  // hasInput carries the input option's PRESENCE separately: undefined
  // means the option is absent (no stdin pipe), distinct from "" (pipe
  // empty stdin — immediate EOF), Node's exact reading of the member.
  let input: IrExpr = emptyStr;
  let hasInput: IrExpr = boolLit(false, loc);
  let cwd: IrExpr = emptyStr;
  let hasEnv: IrExpr = boolLit(false, loc);
  let envPairs: IrExpr = emptyPairs;
  let timeout: IrExpr = numLit(0, loc);
  let stdoutMode = 1;
  let stderrMode = 0;
  let stdinInherit = false;
  // Without an encoding option, a failure's error carries Buffer outputs.
  let encodingGiven = false;
  // A conditional env spread (`...(c ? { env: ... } : {})`): the call
  // itself splits into a ternary of the two env-nesses at the tail.
  let condEnvSpread: { cond: IrExpr; pairs: IrExpr; whenTrue: boolean } | null = null;

  if (optsNode) {
    if (!ts.isObjectLiteralExpression(optsNode)) {
      // A TYPED options VALUE (the interned exec-options record —
      // ExecFileSyncOptionsWithStringEncoding consts and runner params,
      // the windows-ca idiom): members read at RUNTIME. cwd/input/
      // timeout default like the literal path when the field holds
      // undefined; stdio modes compute through an interned helper that
      // validates the runtime strings ("pipe"/"ignore", the same bounds
      // as the literal path — anything else throws a catchable
      // TypeError, as does a non-utf8 runtime encoding: outputs are
      // captured utf8, and mislabeling them without an error would be worse).
      const runtime = lowerExecSyncRuntimeOptions(lowerer, expr, shell, optsNode, loc);
      if (runtime) {
        return {
          kind: "libCall",
          fn: "cp.execSync",
          args: [
            cmdArg,
            argvExpr,
            boolLit(shell, loc),
            runtime.input,
            runtime.hasInput,
            runtime.cwd,
            boolLit(false, loc),
            emptyPairs,
            runtime.timeout,
            runtime.stdoutMode,
            runtime.stderrMode,
            // The runtime options carry a utf8 encoding (others throw).
            boolLit(false, loc),
          ],
          type: STRING,
          loc,
        };
      }
      lowerer.noLowering(
        `${shell ? "execSync" : "execFileSync"} with a non-literal options argument`,
        optsNode,
        "pass the options inline so each member can be checked",
      );
    }
    // stdio member: a single string ("pipe"/"ignore"/"inherit") sets all
    // three, a 3-tuple literal sets each fd. Parsed first so an explicit
    // stderr turns off the echo. "inherit" hands the child the parent's
    // fd (stdout mode 2 / stderr mode 3 / stdin as stdout's bit 4 —
    // scr_runtime.h); nothing captures on an inherited stream, so the
    // call's RESULT is "" where Node answers null (SEMANTICS.md — the
    // mutate-the-terminal spelling discards it).
    const applyStdio = (node: ts.Expression): void => {
      const modeOf = (v: string, fd: 0 | 1 | 2): void => {
        if (v === "pipe") {
          if (fd === 2) stderrMode = 1; // capture, no echo
          return;
        }
        if (v === "ignore") {
          if (fd === 1) stdoutMode = 0;
          if (fd === 2) stderrMode = 2;
          return;
        }
        if (v === "inherit") {
          if (fd === 0) stdinInherit = true;
          if (fd === 1) stdoutMode = 2;
          if (fd === 2) stderrMode = 3;
          return;
        }
        lowerer.noLowering(
          `${shell ? "execSync" : "execFileSync"} with stdio "${v}"`,
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
            lowerer.noLowering(
              `${shell ? "execSync" : "execFileSync"} stdio tuple entries beyond string literals`,
              el,
            );
          }
          modeOf(et.value, i as 0 | 1 | 2);
        });
        return;
      }
      lowerer.noLowering(
        `${shell ? "execSync" : "execFileSync"} with this stdio option`,
        node,
        'stdio takes a "pipe"/"ignore" literal or a 3-tuple of those',
      );
    };

    for (const p of optsNode.properties.nodes) {
      // The conditional-spread idiom carrying `env` — the openssl-runner
      // shape: `...(c ? { env: { ...process.env, ...extra } } : {})`
      // (either orientation). The condition evaluates ONCE and picks
      // between two copies of the exec call — one with the env pairs
      // (built lazily in that arm, where tsc's narrowing of the
      // condition holds), one inheriting — exactly the spread's
      // semantics (lowerExecSyncCall's tail builds the ternary).
      if (ts.isSpreadAssignment(p)) {
        const cs = conditionalSpreadOf(p.expression);
        if (
          cs !== null &&
          cs !== "unsupported" &&
          cs.props.length === 1 &&
          cs.props[0]!.name.text === "env" &&
          ts.isPropertyAssignment(cs.props[0]!)
        ) {
          condEnvSpread = {
            cond: lowerer.lowerCondition(cs.cond),
            pairs: recordToEnvPairs(lowerer, (cs.props[0] as ts.PropertyAssignment).initializer),
            whenTrue: cs.whenTrue,
          };
          continue;
        }
        lowerer.noLowering(
          `${shell ? "execSync" : "execFileSync"} with this options spread`,
          p,
          "the one supported spread is the conditional `...(c ? { env: ... } : {})` (either orientation) — write other members inline",
        );
      }
      const m = optionMember(p);
      if (!m) {
        lowerer.noLowering(
          `${shell ? "execSync" : "execFileSync"} with this options shape`,
          p,
          "spreads and computed keys have no lowering — write each member inline",
        );
      }
      const member = m.name;
      switch (member) {
        case "encoding": {
          const t = lowerer.typeOf(m.value);
          if (!t.isStringLiteralType() || (t.value !== "utf8" && t.value !== "utf-8")) {
            lowerer.noLowering(
              `${shell ? "execSync" : "execFileSync"} with a non-utf8 encoding`,
              m.value,
              'outputs are captured as utf8 — pass { encoding: "utf8" }',
            );
          }
          encodingGiven = true;
          break;
        }
        case "cwd":
          cwd = lowerer.lowerExprExpecting(m.value, STRING);
          break;
        case "input": {
          // string | undefined, Node's exact member semantics: the
          // undefined arm means the option is ABSENT (no stdin pipe),
          // "" pipes EMPTY stdin (the child reads immediate EOF). A
          // union-typed value re-reads for the presence test (the
          // readOpt discipline), so only pure reads qualify — the
          // `options?.input` shape verbatim.
          if (lowerer.typeOf(m.value).flags & ts.TypeFlags.Undefined) {
            // `input: undefined` — Node treats the member as absent.
            break;
          }
          const it = lowerer.mapTypeOf(lowerer.typeOf(m.value));
          const uTag = it?.kind === "union" ? lowerer.armTag(it.unionId, UNDEFINED_T) : -1;
          const sTag = it?.kind === "union" ? lowerer.armTag(it.unionId, STRING) : -1;
          if (it?.kind === "union" && uTag >= 0 && sTag >= 0) {
            if (!isPureReadShape(m.value)) {
              lowerer.noLowering(
                `${shell ? "execSync" : "execFileSync"} with a computed optional input`,
                m.value,
                "the undefined test re-reads the expression — bind the input to a const first",
              );
            }
            const read = lowerer.lowerExpr(m.value);
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
            break;
          }
          input = lowerer.lowerExprExpecting(m.value, STRING);
          hasInput = boolLit(true, loc);
          break;
        }
        case "env": {
          hasEnv = boolLit(true, loc);
          envPairs = recordToEnvPairs(lowerer, m.value);
          // A later inline env member overrides an earlier conditional
          // spread (JS object-literal order); an earlier member stays
          // the spread's false-arm fallback.
          condEnvSpread = null;
          break;
        }
        case "timeout":
          timeout = lowerer.lowerExprExpecting(m.value, F64);
          break;
        case "stdio":
          applyStdio(m.value);
          break;
        case "maxBuffer":
          // Accepted, not enforced (the capture grows unbounded — no
          // real corpus hits the cap); evaluate for side effects.
          lowerer.lowerExpr(m.value);
          break;
        case "killSignal": {
          const t = lowerer.typeOf(m.value);
          if (!t.isStringLiteralType() || t.value !== "SIGTERM") {
            lowerer.noLowering(
              `${shell ? "execSync" : "execFileSync"} with a non-default killSignal`,
              m.value,
              "only the SIGTERM default is implemented for the timeout kill",
            );
          }
          break;
        }
        case "windowsHide":
          lowerer.lowerExpr(m.value); // Node no-op on POSIX
          break;
        case "shell":
          if (shell) {
            lowerer.lowerExpr(m.value);
          } else {
            const t = lowerer.typeOf(m.value);
            if (
              t.flags & ts.TypeFlags.BooleanLiteral &&
              lowerer.checker.typeToString(t) === "false"
            ) {
              // execFileSync's default — a no-op.
            } else {
              lowerer.noLowering(
                "execFileSync with shell enabled",
                m.value,
                "use execSync for shell execution",
              );
            }
          }
          break;
        default:
          lowerer.noLowering(
            `${shell ? "execSync" : "execFileSync"} option '${member}'`,
            p,
            "encoding, cwd, env, input, timeout, stdio, and maxBuffer are the supported options",
          );
      }
    }
  }

  const execCall = (hasE: IrExpr, pairs: IrExpr): IrExpr => ({
    kind: "libCall",
    fn: "cp.execSync",
    args: [
      cmdArg,
      argvExpr,
      boolLit(shell, loc),
      input,
      hasInput,
      cwd,
      hasE,
      pairs,
      timeout,
      numLit(stdoutMode + (stdinInherit ? 4 : 0), loc),
      numLit(stderrMode, loc),
      boolLit(!encodingGiven, loc),
    ],
    type: STRING,
    loc,
  });
  if (condEnvSpread !== null) {
    // The conditional env spread: ONE cond evaluation picks between two
    // copies of the call — every other argument expression is shared
    // between the arms and only the taken arm evaluates, so each still
    // runs exactly once; the env pairs build only in their own arm
    // (where the condition's narrowing holds).
    const withEnv = execCall(boolLit(true, loc), condEnvSpread.pairs);
    const without = execCall(hasEnv, envPairs);
    return {
      kind: "ternary",
      cond: condEnvSpread.cond,
      then: condEnvSpread.whenTrue ? withEnv : without,
      else_: condEnvSpread.whenTrue ? without : withEnv,
      type: STRING,
      loc,
    };
  }
  return execCall(hasEnv, envPairs);
}

/** The RUNTIME half of the exec-options story: a non-literal options
 * argument whose type mapped to the interned exec-options record
 * (ExecFileSyncOptionsWithStringEncoding). cwd/input/timeout read their
 * fields with the literal path's defaults on the undefined arm; the
 * stdio modes (and the encoding gate) compute through interned helpers
 * over the record. The options expression re-reads per member, so only
 * side-effect-free reads qualify (the `in`-operator fold discipline) —
 * bind computed options to a const first. Null when the shape isn't the
 * exec-options record (the caller keeps its fence). */
function lowerExecSyncRuntimeOptions(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  shell: boolean,
  optsNode: ts.Expression,
  loc: SrcLoc,
): {
  input: IrExpr;
  hasInput: IrExpr;
  cwd: IrExpr;
  timeout: IrExpr;
  stdoutMode: IrExpr;
  stderrMode: IrExpr;
} | null {
  const opts = lowerer.lowerExpr(optsNode);
  if (opts.type.kind !== "record") return null;
  const shapeId = opts.type.shapeId;
  const shape = lowerer.shapes.get(shapeId);
  const names = shape?.fields.map((f) => f.name).join(",");
  if (names !== "cwd,encoding,input,maxBuffer,stdio,timeout,windowsHide") return null;
  if (opts.kind !== "varRef" && opts.kind !== "recordGet" && opts.kind !== "fieldGet") {
    lowerer.noLowering(
      `${shell ? "execSync" : "execFileSync"} with a computed options argument`,
      optsNode,
      "the member reads re-read the options — bind the object to a const first",
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
  const emptyStr: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
  const optsT: IrType = { kind: "record", shapeId };
  const modeCall = (fd: 1 | 2): IrExpr => ({
    kind: "call",
    callee: execStdioModeHelper(lowerer, shapeId, fieldType("stdio"), fd, loc),
    args: [opts],
    type: F64,
    loc,
  });
  void optsT;
  // input's PRESENCE rides separately (undefined = the option is absent
  // — no stdin pipe; "" pipes empty stdin): true exactly when the field
  // holds the string arm.
  const inputT = fieldType("input");
  const hasInput: IrExpr =
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
      : { kind: "boolLit", value: true, type: BOOL, loc };
  return {
    input: readOpt("input", emptyStr, STRING),
    hasInput,
    cwd: readOpt("cwd", emptyStr, STRING),
    timeout: readOpt("timeout", { kind: "numLit", value: 0, type: F64, loc }, F64),
    stdoutMode: modeCall(1),
    stderrMode: modeCall(2),
  };
}

/** Interned `%cp.stdioMode.<fd>` — the runtime stdio-mode computation over
 * the exec-options record: undefined stdio keeps the defaults (stdout
 * captured, stderr captured+echoed), a single "pipe"/"ignore" string
 * applies to all three fds, an array reads its fd's entry ("pipe" when
 * the array is short — Node's default per fd). Any other runtime string
 * throws the catchable TypeError the literal path fences at compile
 * time; the fd-1 helper also gates the encoding (utf8/utf-8 only —
 * outputs are captured utf8). */
function execStdioModeHelper(
  lowerer: Lowerer,
  shapeId: string,
  stdioT: IrType,
  fd: 1 | 2,
  loc: SrcLoc,
): string {
  const key = `cp.stdiomode:${shapeId}:${fd}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, `%cp.stdioMode.${fd}`, key);
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
    { id: "e.0", name: "e", type: STRING, mutable: false },
  ];
  // pipe/ignore → the fd's mode; anything else throws (the literal
  // path's fence, moved to runtime). fd 1: pipe=1 (capture), ignore=0.
  // fd 2: pipe=1 (capture, no echo), ignore=2; the no-stdio default is
  // 1 for stdout and 0 (capture+echo) for stderr.
  const modeStmts = (s: IrExpr): IrStmt[] => [
    {
      kind: "if",
      cond: strEq(s, "pipe"),
      then: [{ kind: "return", value: numLit(1, loc), loc }],
      else_: null,
      loc,
    },
    {
      kind: "if",
      cond: strEq(s, "ignore"),
      then: [{ kind: "return", value: numLit(fd === 1 ? 0 : 2, loc), loc }],
      else_: null,
      loc,
    },
    throwType(
      concat(
        concat(strLit('execSync stdio "', loc), s),
        strLit('" has no static lowering ("pipe" and "ignore" are the supported modes)', loc),
      ),
    ),
  ];
  const body: IrStmt[] = [];
  if (fd === 1) {
    // The encoding gate rides the first helper call: outputs are
    // captured utf8, and a runtime encoding this lowering would
    // mislabel throws instead.
    body.push({
      kind: "varDecl",
      localId: "e.0",
      init: { kind: "recordGet", obj: o, shapeId, field: "encoding", type: STRING, loc },
      loc,
    });
    body.push({
      kind: "if",
      cond: {
        kind: "logical",
        op: "&&",
        left: {
          kind: "strEq",
          negated: true,
          left: varRef("e.0", STRING, loc),
          right: strLit("utf8", loc),
          type: BOOL,
          loc,
        },
        right: {
          kind: "strEq",
          negated: true,
          left: varRef("e.0", STRING, loc),
          right: strLit("utf-8", loc),
          type: BOOL,
          loc,
        },
        type: BOOL,
        loc,
      },
      then: [
        throwType(
          concat(
            concat(
              strLit('execSync output is captured as utf8 — encoding "', loc),
              varRef("e.0", STRING, loc),
            ),
            strLit('" has no static lowering', loc),
          ),
        ),
      ],
      else_: null,
      loc,
    });
  }
  if (stdioT.kind !== "union")
    throw new InternalCompilerError("emitter bug: exec-options stdio is not a union");
  const uTag = lowerer.armTag(stdioT.unionId, UNDEFINED_T);
  const sTag = lowerer.armTag(stdioT.unionId, STRING);
  const aTag = lowerer.armTag(stdioT.unionId, arrayOf(STRING));
  const sd: IrExpr = { kind: "recordGet", obj: o, shapeId, field: "stdio", type: stdioT, loc };
  body.push({
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
    then: [{ kind: "return", value: numLit(fd === 1 ? 1 : 0, loc), loc }],
    else_: null,
    loc,
  });
  body.push({
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
  });
  body.push({
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
  });
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
    then: [{ kind: "return", value: numLit(1, loc), loc }],
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
