/* Holds every list that names builtins (libCall ids) to the builtin table
 * (src/ir/builtin-signatures.ts), so the lists cannot drift from it:
 *
 *  - every builtin says whether it can throw (MAY_THROW_LIB_FNS or
 *    NEVER_THROW_LIB_FNS); the builtins that predate the rule are listed in
 *    src/ir/builtin-throw-undecided.txt, a snapshot nothing is added to;
 *  - every row of the runtime symbol tables names a builtin, and a call
 *    without a signature does not pass IR validation;
 *  - every other list of builtins in the compiler's source is typed by
 *    `IrLibFn`, so a name the table does not have fails the build, or is
 *    registered below with the reason it is not and has its names checked
 *    here;
 *  - a builtin decided never to throw has no emitter arm that delivers an
 *    error.
 *
 * A builtin's attributes are still written in lists beside the table. When
 * an attribute becomes a field of the builtin's row, its list leaves this
 * file. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import {
  missingDecisionMessage,
  readUndecided,
  throwCensus,
  UNDECIDED_FILE,
  undecidedDigest,
} from "../../../scripts/builtin-throw-census.mjs";
import { LIB_FN_SYMS, MOCK_TIMER_SYMS, PURE_MATH_LIB_FNS } from "../src/backend/llvm/lib-shared.js";
import { withoutParenthesesAsSatisfiesNonNull as bare } from "../src/frontend/outer-expressions.js";
import { closeSourceParser, parseSourceFile } from "../src/frontend/ts7/source-parser-node.js";
import * as ts from "../src/frontend/ts7/syntax.js";
import { ALWAYS_THROW_LIB_FNS, MAY_THROW_LIB_FNS } from "../src/ir/builtin-effects.js";
import { NEVER_THROW_LIB_FNS } from "../src/ir/builtin-never-throw.js";
import { libFnSignatures } from "../src/ir/builtin-signatures.js";
import { VOID, type IrExpr, type IrModule } from "../src/ir/ir.js";
import { assignLegacyTiers } from "../src/ir/tiers.js";
import { validateModule } from "../src/ir/validate.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const sourceRoot = join(repoRoot, "packages/compiler/src");

const BUILTINS: readonly string[] = Object.keys(libFnSignatures());
const BUILTIN: ReadonlySet<string> = new Set(BUILTINS);
/** The part of a builtin's name before its dot: `fs`, `dyn`, `process`. */
const NAMESPACES: ReadonlySet<string> = new Set(
  BUILTINS.map((name) => name.slice(0, name.indexOf("."))),
);

/** Whether `text` is the start of a builtin's name and no builtin itself:
 * `fs.`, or `test.mockTimers` when there is a `test.mockTimersEnable`. */
function startsBuiltin(text: string): boolean {
  const dot = text.indexOf(".");
  return (
    dot > 0 &&
    !BUILTIN.has(text) &&
    NAMESPACES.has(text.slice(0, dot)) &&
    BUILTINS.some((name) => name.startsWith(text))
  );
}

/** The builtins decided never to throw. A pure Math call is emitted
 * `nounwind`, which is that decision made in the backend. */
const NEVER_THROW: ReadonlySet<string> = new Set<string>([
  ...NEVER_THROW_LIB_FNS,
  ...PURE_MATH_LIB_FNS,
]);

/** The digest of the names in src/ir/builtin-throw-undecided.txt: the 1,301
 * builtins that had no throw decision when the rule was introduced
 * (2026-11-07). The file is a snapshot. A row in MAY_THROW_LIB_FNS or
 * NEVER_THROW_LIB_FNS overrides a builtin's line there, so deciding a
 * builtin, renaming it or deleting it needs no edit to the file, and no
 * builtin can be added to it. `scripts/builtin-throw-census.mjs --prune`
 * drops the lines that are decided or deleted and prints the digest to put
 * here. */
const UNDECIDED_SNAPSHOT = "448945bb7281e1c811765915c413c7b33d463b2134ba5dda278ad546218cb1be";

const undecided: readonly string[] = readUndecided();
const throwDecisions = throwCensus({
  builtins: BUILTINS,
  mayThrow: MAY_THROW_LIB_FNS,
  neverThrow: NEVER_THROW,
  undecided,
});

test("every builtin says whether it can throw", () => {
  expect(throwDecisions.missing, missingDecisionMessage(throwDecisions.missing)).toEqual([]);
  expect(
    throwDecisions.contradictory,
    "in MAY_THROW_LIB_FNS and also decided never to throw (NEVER_THROW_LIB_FNS, or PURE_MATH_LIB_FNS, whose calls are emitted nounwind)",
  ).toEqual([]);
  expect(
    [...ALWAYS_THROW_LIB_FNS].filter((name) => !MAY_THROW_LIB_FNS.has(name)),
    "a builtin that always throws is also a row of MAY_THROW_LIB_FNS: the backends read that set",
  ).toEqual([]);
});

test("nothing is added to the builtins with no throw decision", () => {
  expect(
    undecidedDigest(undecided),
    [
      `${UNDECIDED_FILE} was edited. It is a snapshot of the builtins that had no throw decision when the rule was`,
      "introduced, and a new builtin never goes into it: add the builtin to MAY_THROW_LIB_FNS or NEVER_THROW_LIB_FNS.",
      "A decided, renamed or deleted builtin needs no edit there either. To drop such lines, run",
      "pnpm exec tsx scripts/builtin-throw-census.mjs --prune and put the digest it prints in UNDECIDED_SNAPSHOT.",
    ].join("\n"),
  ).toBe(UNDECIDED_SNAPSHOT);
});

test("every runtime symbol row names a builtin", () => {
  const unknown = [...Object.keys(LIB_FN_SYMS), ...Object.keys(MOCK_TIMER_SYMS)].filter(
    (name) => !BUILTIN.has(name),
  );
  expect(
    unknown,
    "a row of LIB_FN_SYMS or MOCK_TIMER_SYMS whose name has no signature in ir/builtin-signatures.ts: nothing can emit it",
  ).toEqual([]);
});

test("a libCall whose name has no signature does not pass IR validation", () => {
  // What makes a list's row without a signature dead: no call reaches it.
  const loc = { file: "unknown-builtin.ts", start: 0, end: 0 };
  const call = { kind: "libCall", fn: "child.propsInstall", args: [], type: VOID, loc };
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    unions: [],
    functions: [
      {
        name: "main",
        params: [],
        locals: [],
        returnType: VOID,
        body: [{ kind: "exprStmt", expr: call as unknown as IrExpr, loc }],
        loc,
      },
    ],
  };
  assignLegacyTiers(mod.functions);
  expect(validateModule(mod).map((error) => error.message)).toEqual([
    'in main: libCall of unknown library function "child.propsInstall"',
  ]);
});

/* ---- lists of builtins written in the source ---- */

/** Why a list of builtins is not typed by `IrLibFn`, and what its members
 * are held to:
 *  - "names": every member is a builtin;
 *  - "prefixes": every member is a builtin or the start of one (the list
 *    is matched with startsWith);
 *  - "other": the list is not about builtins; one of its members happens
 *    to be spelled like one. */
interface UntypedList {
  readonly members: "names" | "prefixes" | "other";
  readonly why: string;
}

/** An object literal whose keys are builtins. Typed
 * `Partial<Record<IrLibFn, …>>`, the natively compiled compiler would lay
 * it out as a record with one field per builtin (2,376 of them) instead of
 * a dictionary, so its keys are checked here. */
const table = (what: string): UntypedList => ({
  members: "names",
  why: `${what}: an object table read by a builtin's name; a closed key type would change its layout in the natively compiled compiler`,
});
/** An object literal indexed where `e.fn` is already narrowed to the keys:
 * TypeScript requires a key for every name the narrowing leaves. */
const narrowed = (what: string): UntypedList => ({
  members: "names",
  why: `${what}: indexed by a narrowed e.fn, so a missing key fails the build`,
});
const prefixes = (what: string): UntypedList => ({
  members: "prefixes",
  why: `${what}: name prefixes matched with startsWith`,
});

/** Every list of builtins in the compiler's source that `IrLibFn` does not
 * type, by `file#declaration`. Nothing else is accepted: a new list is a
 * `ReadonlySet<IrLibFn>` or a `ReadonlyMap<IrLibFn, …>`. */
const UNTYPED_LISTS: Readonly<Record<string, UntypedList>> = {
  "backend/llvm/bigint-wrap.ts#BINARY": table("the operator of each BigInt builtin"),
  "backend/llvm/lib-datagram.ts#direct": table("runtime symbols of the node:dgram builtins"),
  "backend/llvm/lib-filesystem.ts#FS_ALWAYS_THROW_SYMS": table(
    "runtime symbols of the fs argument ladders",
  ),
  "backend/llvm/lib-http2.ts#direct": table("runtime symbols of the node:http2 builtins"),
  "backend/llvm/lib-network.ts#emitNetworkHttpLibCall": {
    members: "names",
    why: "an array tested with includes(e.fn) and three tables indexed by a narrowed e.fn",
  },
  "backend/llvm/lib-process.ts#emitAsyncContextLibCall": narrowed(
    "runtime symbols of the timer builtins",
  ),
  "backend/llvm/lib-shared.ts#LIB_FN_SYMS": table("the runtime symbol of each builtin"),
  "backend/llvm/lib-shared.ts#MOCK_TIMER_SYMS": table("mock-aware symbols of the timer builtins"),
  "backend/llvm/lib-stream.ts#kindOf": table("the hook each stream setter installs"),
  "backend/llvm/lib-stream.ts#symOf": table("runtime symbols of the stream setters"),
  "backend/llvm/reference-writes.ts#INERT_LIB_PREFIXES": prefixes(
    "builtin families that store nothing",
  ),
  "backend/target-diagnostics.ts#prefixes": prefixes("surfaces WASI Preview 1 lacks"),
  "frontend/lowering/class-dynamic-dispatch.ts#process": {
    members: "names",
    why: "an array tested with includes(expr.fn)",
  },
  "frontend/lowering/width-copies.ts#READ_ONLY_RUNTIME_CALLS": prefixes(
    "runtime calls that read typed operands and neither write nor compare them",
  ),
  "ir/jsval.ts#CONSUMERS": table("the jsval twin of each consuming dyn builtin"),
  "ir/jsval.ts#PRODUCERS": table("the jsval twin of each producing dyn builtin"),
  "ir/runtime-features.ts#CHILD_PROCESS_LIB_PREFIXES": prefixes(
    "builtins that link the child-process unit",
  ),
  "ir/runtime-features.ts#NET_PREFIXES": prefixes("builtins that link the net unit"),
  "ir/runtime-features.ts#READABLE_DYN_ASYNC_PREFIXES": prefixes(
    "builtins that link the dynamic Readable unit",
  ),
  "ir/runtime-features.ts#RUNTIME_FEATURE_RULES": prefixes(
    "the `prefixes` of each runtime feature's rule",
  ),
  "ir/runtime-features.ts#STREAM_LIB_PREFIXES": prefixes("builtins that link the stream unit"),
  "ir/runtime-features.ts#URL_PREFIXES": prefixes("builtins that link the URL units"),
  "ir/validate.ts#CRYPTO_PROMISE_VALUES": table("value kinds of the promisified crypto builtins"),
  "library/ir-policy.ts#LIB_MODE_REFUSED_PREFIXES": prefixes("builtin families a library refuses"),
  "library/ir-policy.ts#LIB_NONDETERMINISTIC_PREFIXES": prefixes(
    "builtin families a deterministic library refuses",
  ),
  "node-islands/detect.ts#ALLOWED_BUILTIN_WRITES": {
    members: "other",
    why: "JavaScript member paths; process.exitCode is also a builtin's name",
  },
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts") &&
      !name.includes(".generated.")
    )
      out.push(path);
  }
  return out;
}

/** The compiler's source files, parsed, by their path under src/. */
const SOURCES: ReadonlyMap<string, ts.SourceFile> = new Map(
  sourceFiles(sourceRoot).map((file) => [
    relative(sourceRoot, file).split("\\").join("/"),
    parseSourceFile(file, readFileSync(file, "utf8"), "ts"),
  ]),
);
afterAll(closeSourceParser);

/** The types written on `node`'s wrappers and on a `new Set<…>` or
 * `new Map<…>` under them. */
function writtenTypes(node: ts.Expression): string {
  const types: string[] = [];
  for (;;) {
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      types.push(ts.getTextOfNode(node.type));
      node = node.expression;
    } else if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node))
      node = node.expression;
    else break;
  }
  if (ts.isNewExpression(node))
    for (const argument of node.typeArguments?.nodes ?? []) types.push(ts.getTextOfNode(argument));
  return types.join(" ");
}

/** The names a collection literal lists: the strings of an array or a Set,
 * the first string of each pair of a Map or a pair list, the string keys of
 * an object. Undefined for any other expression. */
function listedNames(node: ts.Expression): string[] | undefined {
  node = bare(node);
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    (node.expression.text === "Set" || node.expression.text === "Map") &&
    node.arguments?.nodes.length === 1
  )
    return listedNames(node.arguments.nodes[0]!);
  if (ts.isArrayLiteralExpression(node)) {
    const names: string[] = [];
    for (const element of node.elements.nodes) {
      let item = bare(element);
      if (ts.isArrayLiteralExpression(item) && item.elements.nodes.length > 0)
        item = bare(item.elements.nodes[0]!);
      if (ts.isStringLiteralLike(item)) names.push(item.text);
    }
    return names;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const names: string[] = [];
    for (const property of node.properties.nodes)
      if (property.name !== undefined && ts.isStringLiteralLike(property.name))
        names.push(property.name.text);
    return names;
  }
  return undefined;
}

/** The nearest named function or method that holds `node`, or else the
 * top-level variable that does, by name. */
function ownerName(node: ts.Node): string {
  let variable = "(module)";
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (
      (ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) &&
      at.name !== undefined &&
      ts.isIdentifier(at.name)
    )
      return at.name.text;
    if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) variable = at.name.text;
  }
  return variable;
}

/** Every collection literal in the compiler's source that lists a builtin
 * or the start of one and that no written `IrLibFn` types, with the names
 * it lists, by `file#declaration`. Three forms hold such a list without a
 * type from their context: a variable's initializer, an array literal a
 * method is called on (`[…].includes(fn)`), and an object literal that is
 * indexed (`{…}[fn]`). A literal stored in a property or passed as an
 * argument is typed by the property or the parameter; a property's list
 * that holds the start of a builtin's name cannot be typed by `IrLibFn`, so
 * it is a prefix list and counts too. */
function untypedBuiltinLists(): Map<string, string[]> {
  const lists = new Map<string, string[]>();
  for (const [name, source] of SOURCES) {
    // The table itself.
    if (name === "ir/builtin-signatures.ts") continue;
    const note = (
      owner: string,
      literal: ts.Expression,
      declared: string,
      prefixesOnly = false,
    ): void => {
      const names = listedNames(literal);
      if (names === undefined) return;
      if (!names.some((item) => startsBuiltin(item) || (!prefixesOnly && BUILTIN.has(item))))
        return;
      if (/\bIrLibFn\b/.test(`${declared} ${writtenTypes(literal)}`)) return;
      const site = `${name}#${owner}`;
      lists.set(site, [...(lists.get(site) ?? []), ...names]);
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer !== undefined &&
        ts.isIdentifier(node.name)
      )
        note(
          node.name.text,
          node.initializer,
          node.type === undefined ? "" : ts.getTextOfNode(node.type),
        );
      else if (
        ts.isPropertyAccessExpression(node) &&
        ts.isArrayLiteralExpression(bare(node.expression))
      )
        note(ownerName(node), node.expression, "");
      else if (
        ts.isElementAccessExpression(node) &&
        ts.isObjectLiteralExpression(bare(node.expression))
      )
        note(ownerName(node), node.expression, "");
      else if (ts.isPropertyAssignment(node) && ts.isArrayLiteralExpression(bare(node.initializer)))
        note(ownerName(node), node.initializer, "", true);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return lists;
}

const untypedLists = untypedBuiltinLists();

test("a list of builtins is typed by the builtin table", () => {
  expect(
    [...untypedLists.keys()].sort(),
    [
      "The lists of builtins that IrLibFn does not type differ from the registered ones (UNTYPED_LISTS), named file#declaration.",
      "A new list: declare it ReadonlySet<IrLibFn> or ReadonlyMap<IrLibFn, …> (new Set<IrLibFn>([…])), so a name",
      "without a signature fails the build. If it lists prefixes, or is not about builtins and only spells a name like one,",
      "register it in UNTYPED_LISTS with the reason. A registered list that is gone, renamed or typed now: update its entry.",
    ].join("\n"),
  ).toEqual(Object.keys(UNTYPED_LISTS).sort());
});

test("a list of builtins that is not typed names builtins", () => {
  const unknown: string[] = [];
  for (const [site, names] of untypedLists) {
    const members = UNTYPED_LISTS[site]?.members ?? "names";
    if (members === "other") continue;
    for (const name of new Set(names)) {
      if (BUILTIN.has(name)) continue;
      if (members === "prefixes" && startsBuiltin(name)) continue;
      unknown.push(`${site}: ${name}`);
    }
  }
  expect(
    unknown,
    "names no builtin in ir/builtin-signatures.ts (and, in a prefix list, starts none): nothing matches it",
  ).toEqual([]);
});

/* ---- errors delivered by an emitter arm ---- */

/** Whether `node` reads a `fn`: `fn`, `e.fn`, `call.fn`. */
function readsFn(node: ts.Expression): boolean {
  return /(^|\.)fn$/.test(ts.getTextOfNode(bare(node)));
}

/** The builtins a condition holds for when it tests a `fn` against names:
 * `e.fn === "a" || e.fn === "b"`, `["a", "b"].includes(e.fn)`, and either
 * of them and-ed with another condition. Undefined for other conditions. */
function builtinsTested(condition: ts.Expression): string[] | undefined {
  condition = bare(condition);
  if (ts.isBinaryExpression(condition)) {
    const operator = condition.operatorToken.kind;
    if (operator === ts.SyntaxKind.BarBarToken) {
      const left = builtinsTested(condition.left);
      const right = builtinsTested(condition.right);
      return left !== undefined && right !== undefined ? [...left, ...right] : undefined;
    }
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken)
      return builtinsTested(condition.left) ?? builtinsTested(condition.right);
    if (
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      readsFn(condition.left) &&
      ts.isStringLiteralLike(condition.right)
    )
      return [condition.right.text];
    return undefined;
  }
  if (
    ts.isCallExpression(condition) &&
    ts.isPropertyAccessExpression(condition.expression) &&
    condition.expression.name.text === "includes" &&
    condition.arguments.nodes.length === 1 &&
    readsFn(condition.arguments.nodes[0]!)
  )
    return listedNames(condition.expression.expression);
  return undefined;
}

/** The builtins whose emitter arm delivers an error: for each
 * `emitPendingCheck()` in the backend, the builtins that the nearest test
 * of `fn` around it names (an `if` whose condition `builtinsTested` reads,
 * or the `case` labels of a `switch` over a `fn`), with the place of the
 * check. A check under `MAY_THROW_LIB_FNS.has(…)` and one that no such test
 * surrounds name no builtin. */
function builtinsWithPendingCheck(): Map<string, string> {
  const checked = new Map<string, string>();
  for (const [name, source] of SOURCES) {
    if (!name.startsWith("backend/")) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "emitPendingCheck"
      ) {
        const line = source.getLineAndCharacterOfPosition(ts.tokenStartOfNode(node)).line + 1;
        let names: string[] | undefined;
        for (
          let inner: ts.Node = node, at = node.parent;
          at !== undefined;
          inner = at, at = at.parent
        ) {
          if (ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) break;
          if (ts.isIfStatement(at) && at.thenStatement === inner) {
            if (ts.getTextOfNode(at.expression).includes("MAY_THROW_LIB_FNS.has(")) break;
            names = builtinsTested(at.expression);
          } else if (
            ts.isCaseClause(at) &&
            ts.isCaseBlock(at.parent) &&
            ts.isSwitchStatement(at.parent.parent) &&
            readsFn(at.parent.parent.expression)
          ) {
            // The labels that fall into this clause, and its own.
            names = [];
            const clauses = at.parent.clauses.nodes;
            for (let i = clauses.indexOf(at); i >= 0; i--) {
              const clause = clauses[i]!;
              if (clause !== at && clause.statements.nodes.length > 0) break;
              if (ts.isCaseClause(clause) && ts.isStringLiteralLike(clause.expression))
                names.push(clause.expression.text);
            }
          }
          if (names !== undefined) break;
        }
        for (const builtin of names ?? [])
          if (BUILTIN.has(builtin) && !checked.has(builtin))
            checked.set(builtin, `${name}:${line}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return checked;
}

test("a builtin whose emitter arm delivers an error is not decided never to throw", () => {
  const contradictions: string[] = [];
  for (const [builtin, where] of builtinsWithPendingCheck())
    if (NEVER_THROW.has(builtin)) contradictions.push(`${builtin} (${where})`);
  expect(
    contradictions,
    [
      "Decided never to throw (NEVER_THROW_LIB_FNS, or PURE_MATH_LIB_FNS), but the emitter arm at the place named",
      "emits a pending check after the runtime call, and that check is how a thrown error reaches the program.",
      "Move the builtin to MAY_THROW_LIB_FNS. If the check is for another builtin of the same arm, test e.fn where",
      "the check is emitted.",
    ].join("\n"),
  ).toEqual([]);
});
