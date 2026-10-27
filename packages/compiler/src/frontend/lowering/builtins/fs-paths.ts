/* fs path arguments given as file: URLs. Node converts a URL path with
 * fileURLToPath inside each function (getValidatedPath), after every
 * argument has been evaluated, and validates some arguments before the
 * path and others after it. A URL-typed path lowers to the same
 * conversion (url.fileURLToPathUrl). The later arguments through the last
 * one with side effects are evaluated into hidden locals before the
 * conversion, in source order, so they run even when it throws and each
 * reads what it reads in Node. Before the conversion, an earlier string
 * path gets its null-byte check (copyFileSync, renameSync) and a runtime
 * readFileSync encoding its name check, which Node runs first. existsSync
 * and the fs.promises functions convert to a value instead
 * (url.fileURLToPathValue) and answer false or a rejected promise for a
 * conversion error. An argument Node validates before the path must
 * otherwise be absent or a literal that passes that validation; other
 * forms fence with SC2020. */
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { sideEffectFreeOptionValue } from "../surfaces.js";
import { stripTypeWrappers } from "../typed-arguments.js";
import { boolLit, varRef } from "../../../ir/build.js";
import { BOOL, DYN, type IrExpr, type IrStmt, STRING, URL_T, VOID } from "../../../ir/ir.js";
import { InternalCompilerError } from "../../../errors.js";

interface FsPathRow {
  /** The path parameter indexes. */
  readonly paths: readonly number[];
  /** Whether Node validates the paths before every other argument
   * (otherwise the options come first). */
  readonly pathsFirst: boolean;
  /** The path parameters' names in Node's errors, when there are two. */
  readonly names?: readonly string[];
}

/** The fs functions whose path parameters accept a URL. */
const FS_URL_PATHS: Readonly<Record<string, FsPathRow>> = {
  accessSync: { paths: [0], pathsFirst: true },
  appendFileSync: { paths: [0], pathsFirst: false },
  chmodSync: { paths: [0], pathsFirst: true },
  chownSync: { paths: [0], pathsFirst: true },
  copyFileSync: { paths: [0, 1], pathsFirst: true, names: ["src", "dest"] },
  lchownSync: { paths: [0], pathsFirst: true },
  lstatSync: { paths: [0], pathsFirst: true },
  mkdirSync: { paths: [0], pathsFirst: false },
  mkdtempSync: { paths: [0], pathsFirst: false },
  openSync: { paths: [0], pathsFirst: true },
  opendirSync: { paths: [0], pathsFirst: true },
  readFileSync: { paths: [0], pathsFirst: false },
  readdirSync: { paths: [0], pathsFirst: false },
  realpathSync: { paths: [0], pathsFirst: false },
  "realpathSync.native": { paths: [0], pathsFirst: false },
  renameSync: { paths: [0, 1], pathsFirst: true, names: ["oldPath", "newPath"] },
  rmSync: { paths: [0], pathsFirst: false },
  rmdirSync: { paths: [0], pathsFirst: true },
  statSync: { paths: [0], pathsFirst: true },
  truncateSync: { paths: [0], pathsFirst: true },
  unlinkSync: { paths: [0], pathsFirst: true },
  writeFileSync: { paths: [0], pathsFirst: false },
};

/** The fs.promises functions with path parameters. */
const FSP_PATHS: Readonly<Record<string, FsPathRow>> = {
  access: { paths: [0], pathsFirst: true },
  appendFile: { paths: [0], pathsFirst: false },
  chmod: { paths: [0], pathsFirst: true },
  chown: { paths: [0], pathsFirst: true },
  copyFile: { paths: [0, 1], pathsFirst: true },
  lchown: { paths: [0], pathsFirst: true },
  lstat: { paths: [0], pathsFirst: true },
  mkdir: { paths: [0], pathsFirst: false },
  mkdtemp: { paths: [0], pathsFirst: false },
  open: { paths: [0], pathsFirst: true },
  opendir: { paths: [0], pathsFirst: true },
  readFile: { paths: [0], pathsFirst: false },
  readdir: { paths: [0], pathsFirst: false },
  realpath: { paths: [0], pathsFirst: false },
  rename: { paths: [0, 1], pathsFirst: true },
  rm: { paths: [0], pathsFirst: true },
  rmdir: { paths: [0], pathsFirst: true },
  stat: { paths: [0], pathsFirst: true },
  truncate: { paths: [0], pathsFirst: true },
  unlink: { paths: [0], pathsFirst: true },
  writeFile: { paths: [0], pathsFirst: false },
};

/** What a path argument of an fs call lowers to (Lowerer.fsPathPlans). */
export type FsPathPlan =
  /** The first URL path: the later arguments with effects, the earlier
   * string paths to check, and a runtime encoding to check, all before the
   * conversion. */
  | {
      kind: "convert";
      staged: ts.Expression[];
      checks: { path: ts.Expression; name: string }[];
      encoding: ts.Expression | null;
    }
  /** A string path that a later URL path checks: the local that holds it,
   * once lowered. */
  | { kind: "save"; local: string | null }
  /** A URL path whose conversion error becomes false or a rejection: the
   * local that holds the conversion's value. */
  | { kind: "value"; local: string };

function isUrlArgument(lowerer: Lowerer, node: ts.Expression | undefined): boolean {
  return node !== undefined && lowerer.mapTypeOf(lowerer.typeOf(node))?.kind === "url";
}

function stripParens(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** A literal that Node's option validation accepts before it reads the
 * path: a string (the checker admits only the declared encodings, flags
 * and type names), a boolean, an integer in [0, 2^31 - 1] (every numeric
 * option of these functions accepts that range), undefined or null, or an
 * object literal of those. */
function preValidatedLiteral(node: ts.Expression): boolean {
  const e = stripParens(node);
  if (ts.isStringLiteralLike(e)) return true;
  if (
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword
  )
    return true;
  if (ts.isIdentifier(e)) return e.text === "undefined";
  if (ts.isNumericLiteral(e)) {
    const value = Number(e.text);
    return Number.isInteger(value) && value >= 0 && value <= 2147483647;
  }
  if (ts.isObjectLiteralExpression(e)) {
    return e.properties.nodes.every(
      (p) =>
        ts.isPropertyAssignment(p) &&
        !ts.isComputedPropertyName(p.name) &&
        preValidatedLiteral(p.initializer),
    );
  }
  return false;
}

const HINT = "convert the URL first: fileURLToPath(url) from node:url";

/** SC2020 for an argument Node validates before the paths that is neither
 * absent nor a literal passing that validation, other than a string
 * readFileSync encoding (returned: it is checked before the conversion).
 * writeFileSync/appendFileSync's data is checked after the path. */
function optionsBeforePaths(
  lowerer: Lowerer,
  args: readonly ts.Expression[],
  member: string,
  row: FsPathRow,
  name: string,
): ts.Expression | null {
  if (row.pathsFirst) return null;
  const data = /^(writeFile|appendFile)(Sync)?$/.test(member) ? 1 : -1;
  let encoding: ts.Expression | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (row.paths.includes(i) || i === data || preValidatedLiteral(arg)) continue;
    if (
      member === "readFileSync" &&
      i === 1 &&
      lowerer.mapTypeOf(lowerer.typeOf(arg))?.kind === "string"
    ) {
      encoding = stripTypeWrappers(arg);
      continue;
    }
    lowerer.noLowering(`${name} with a URL path and options that are not literals`, arg, HINT);
  }
  return encoding;
}

/** The arguments after the URL path that are evaluated ahead of the
 * conversion: every one through the last with effects or that `force`
 * names, in source order. An object or array literal among them is
 * SC2020: its members are lowered one by one, so it cannot be evaluated
 * ahead of the conversion as one value. */
function stagedAfter(
  lowerer: Lowerer,
  args: readonly ts.Expression[],
  first: number,
  name: string,
  force: (e: ts.Expression, i: number) => boolean,
): ts.Expression[] {
  // Every argument from the URL through the last one with effects (or that
  // the caller forces) is evaluated ahead of the conversion, in source
  // order: a later argument's effect (an assignment, say) must not change
  // what an earlier one read.
  let last = first;
  for (let i = first + 1; i < args.length; i++) {
    const e = stripTypeWrappers(args[i]!);
    if (!sideEffectFreeOptionValue(e) || force(e, i)) last = i;
  }
  const staged: ts.Expression[] = [];
  for (let i = first + 1; i <= last; i++) {
    // Keyed without type-only wrappers (`satisfies`, `as`, `!`), so a
    // lowering that reads through them finds the saved value.
    const e = stripTypeWrappers(args[i]!);
    // Literals are read by their members, so a whole-value slot cannot
    // hold them.
    if (ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e)) {
      lowerer.noLowering(
        sideEffectFreeOptionValue(e)
          ? `${name} with a URL path and a literal before a later argument that has effects`
          : `${name} with a URL path and a later literal that has effects`,
        e,
        HINT,
      );
    }
    staged.push(e);
  }
  return staged;
}

/** Plans the URL paths of a synchronous fs call (see the file comment):
 * the check every fs call runs before lowering its arguments. */
export function checkFsUrlPaths(
  lowerer: Lowerer,
  call: ts.CallExpression,
  bi: { module: string; member: string },
): void {
  if (bi.module !== "fs") return;
  const row = FS_URL_PATHS[bi.member];
  if (!row) return;
  const args = call.arguments.nodes;
  const first = row.paths.find((i) => isUrlArgument(lowerer, args[i]));
  if (first === undefined || lowerer.fsPathPlans.has(stripParens(args[first]!))) return;
  const name = bi.member;
  if (args.some(ts.isSpreadElement))
    lowerer.noLowering(`${name} with spread arguments and a URL path`, call);
  const checks: { path: ts.Expression; name: string }[] = [];
  for (const i of row.paths) {
    if (i >= first || args[i] === undefined) continue;
    const path = stripParens(args[i]!);
    checks.push({ path, name: row.names?.[i] ?? "path" });
    lowerer.fsPathPlans.set(path, { kind: "save", local: null });
  }
  const encoding = optionsBeforePaths(lowerer, args, bi.member, row, name);
  const staged = stagedAfter(lowerer, args, first, name, (e) => e === encoding);
  for (const e of staged) lowerer.stagedArguments.set(e, null);
  lowerer.fsPathPlans.set(stripParens(args[first]!), { kind: "convert", staged, checks, encoding });
}

/** existsSync and the fs.promises functions with URL paths: each URL
 * converts to a value (url.fileURLToPathValue) after the arguments are
 * evaluated, and the call runs on the converted paths only when every
 * conversion produced a string; otherwise existsSync answers false and an
 * fs.promises function a promise rejected with the first conversion's
 * error. `lowerCall` lowers the call itself, whose URL paths then read the
 * converted values. Null for every other call. */
export function lowerFallibleFsUrlCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  bi: { module: string; member: string },
  lowerCall: () => IrExpr,
): IrExpr | null {
  const row =
    bi.module === "fs/promises"
      ? FSP_PATHS[bi.member]
      : bi.module === "fs" && bi.member === "existsSync"
        ? ({ paths: [0], pathsFirst: true } satisfies FsPathRow)
        : undefined;
  if (!row) return null;
  const args = call.arguments.nodes;
  const urls = row.paths.filter((i) => isUrlArgument(lowerer, args[i]));
  if (urls.length === 0 || lowerer.fallibleFsCalls.has(call)) return null;
  const name = bi.module === "fs/promises" ? `fs.promises.${bi.member}` : bi.member;
  if (args.some(ts.isSpreadElement))
    lowerer.noLowering(`${name} with spread arguments and a URL path`, call);
  const first = urls[0]!;
  // A string path before the URL would be checked in the call itself,
  // after the conversion.
  if (row.paths.some((i) => i < first && args[i] !== undefined))
    lowerer.noLowering(`${name} with a string path before a URL path`, call, HINT);
  if (optionsBeforePaths(lowerer, args, bi.member, row, name) !== null)
    lowerer.noLowering(`${name} with a URL path and options that are not literals`, args[1]!, HINT);
  const loc = locOf(call);
  const stmts: IrStmt[] = [];
  const values = new Map<number, string>();
  const save = (value: IrExpr, label: string, at: ts.Node): string => {
    const slot = lowerer.declareHiddenLocal(label, value.type);
    stmts.push({ kind: "varDecl", localId: slot.id, init: value, loc: locOf(at) });
    return slot.id;
  };
  values.set(first, save(lowerer.lowerExprExpecting(args[first]!, URL_T), "%fsUrl", args[first]!));
  const staged = stagedAfter(lowerer, args, first, name, (_e, i) => urls.includes(i));
  for (const e of staged) {
    // A call lowered again (an array-literal element) evaluates the
    // argument anew; the slot an earlier lowering saved it in is gone.
    lowerer.stagedArguments.delete(e);
    const value = lowerer.lowerExpr(e);
    const slot = save(value, "%fsArg", e);
    lowerer.stagedArguments.set(e, { localId: slot, type: value.type });
    const index = args.findIndex((arg) => stripTypeWrappers(arg) === e);
    if (urls.includes(index)) values.set(index, slot);
  }
  const results: string[] = [];
  for (const i of urls) {
    const url = varRef(values.get(i)!, URL_T, loc);
    const converted: IrExpr = {
      kind: "libCall",
      fn: "url.fileURLToPathValue",
      args: [url],
      type: DYN,
      loc,
    };
    const local = save(converted, "%fsPathValue", args[i]!);
    lowerer.fsPathPlans.set(stripParens(args[i]!), { kind: "value", local });
    results.push(local);
  }
  lowerer.fallibleFsCalls.add(call);
  let inner: IrExpr;
  try {
    inner = lowerCall();
  } finally {
    lowerer.fallibleFsCalls.delete(call);
  }
  let result = inner;
  for (let k = results.length - 1; k >= 0; k--) {
    const value = varRef(results[k]!, DYN, loc);
    const failed: IrExpr =
      bi.module === "fs/promises"
        ? { kind: "intrinsic", name: "promise.reject", args: [value], type: inner.type, loc }
        : boolLit(false, loc);
    result = {
      kind: "ternary",
      cond: { kind: "dynTest", test: "string", value, type: BOOL, loc },
      then: result,
      else_: failed,
      type: inner.type,
      loc,
    };
  }
  return { kind: "seqExpr", stmts, result, type: inner.type, loc };
}

/** An fs path argument as a string: a URL converts with fileURLToPath's
 * conversion (url.fileURLToPathUrl), which throws Node's errors for other
 * schemes, hosts and encoded separators, after the checks its plan names. */
export function lowerFsPath(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const loc = locOf(node);
  const plan = lowerer.fsPathPlans.get(stripParens(node));
  if (plan?.kind === "value")
    return { kind: "dynCheck", value: varRef(plan.local, DYN, loc), type: STRING, loc };
  if (!isUrlArgument(lowerer, node)) {
    const value = lowerer.lowerExprExpecting(node, STRING);
    if (plan?.kind !== "save") return value;
    const slot = lowerer.declareHiddenLocal("%fsPath", STRING);
    plan.local = slot.id;
    return {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: slot.id, init: value, loc }],
      result: varRef(slot.id, STRING, loc),
      type: STRING,
      loc,
    };
  }
  const url = lowerer.lowerExprExpecting(node, URL_T);
  if (plan?.kind !== "convert")
    return { kind: "libCall", fn: "url.fileURLToPathUrl", args: [url], type: STRING, loc };
  // The URL and the later arguments with effects, in source order, then
  // the checks Node runs first, then the conversion.
  const saved = lowerer.declareHiddenLocal("%fsUrl", URL_T);
  const stmts: IrStmt[] = [{ kind: "varDecl", localId: saved.id, init: url, loc }];
  for (const arg of plan.staged) {
    lowerer.stagedArguments.delete(arg);
    const value = lowerer.lowerExpr(arg);
    const slot = lowerer.declareHiddenLocal("%fsArg", value.type);
    stmts.push({ kind: "varDecl", localId: slot.id, init: value, loc: locOf(arg) });
    lowerer.stagedArguments.set(arg, { localId: slot.id, type: value.type });
  }
  const check = (fn: "fs.checkPath" | "fs.checkReadEncoding", args: IrExpr[]): void => {
    stmts.push({ kind: "exprStmt", expr: { kind: "libCall", fn, args, type: VOID, loc }, loc });
  };
  for (const { path, name } of plan.checks) {
    const saved = lowerer.fsPathPlans.get(path);
    if (saved?.kind !== "save" || saved.local === null)
      throw new InternalCompilerError("an fs path checked before it was lowered");
    check("fs.checkPath", [
      varRef(saved.local, STRING, loc),
      { kind: "strLit", value: name, type: STRING, loc },
    ]);
  }
  if (plan.encoding !== null) {
    const slot = lowerer.stagedArguments.get(plan.encoding);
    if (!slot) throw new InternalCompilerError("an fs encoding checked before it was saved");
    check("fs.checkReadEncoding", [
      lowerer.coerceToExpected(varRef(slot.localId, slot.type, loc), STRING),
    ]);
  }
  return {
    kind: "seqExpr",
    stmts,
    result: {
      kind: "libCall",
      fn: "url.fileURLToPathUrl",
      args: [{ kind: "varRef", localId: saved.id, type: URL_T, loc }],
      type: STRING,
      loc,
    },
    type: STRING,
    loc,
  };
}

/** Whether `index` is a path parameter of the fs or fs.promises function
 * `member`. */
export function isFsPathParam(module: string, member: string, index: number): boolean {
  if (module === "fs/promises") return FSP_PATHS[member]?.paths.includes(index) === true;
  if (module !== "fs") return false;
  return (
    (member === "existsSync" && index === 0) || FS_URL_PATHS[member]?.paths.includes(index) === true
  );
}
