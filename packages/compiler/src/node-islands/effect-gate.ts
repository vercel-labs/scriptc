/* The static effect gate for deferred island modules (scope-B NI-7,
 * DESIGN.md §2.7; ND §17.1). An island module may evaluate later than its
 * import position only when its evaluation is unobservable: no output, no
 * I/O, no listeners or timers, no writes to globals, builtins or other
 * modules, no reads of inputs native code can change (process.env, cwd,
 * files), and no throw. The gate is the conservative half of that proof:
 * it admits a module only when the top-level code of every file it loads
 * (the closure over literal require()/import specifiers) is built from the
 * forms below, which cannot have effects whatever the environment.
 *
 * NI-7b: the gate is the static tier only. Whether a module defers is
 * decided by the build-time probe's load recording (probe-recorder.ts):
 * a load that reads no run-time input is deterministic, so one recorded
 * run without effects proves deferral unobservable whether or not the
 * gate admits the code (bundles such as esbuild output never pass the
 * gate). The gate's verdict is reported with the decision.
 *
 * Admitted top-level statements (per file, CommonJS or ES module):
 *   - directives ("use strict"), empty statements;
 *   - function declarations (bodies do not run at load);
 *   - class declarations without decorators or static blocks, whose
 *     `extends`, computed member names and static field initializers are
 *     pure expressions;
 *   - var/let/const declarations with pure initializers, including object
 *     and array binding patterns without defaults;
 *   - assignments of pure expressions to `exports.x`, `module.exports`,
 *     `module.exports.x`, or a member chain rooted at a binding declared in
 *     the same file (a function, class or pure object: `F.prototype.m = …`);
 *   - `Object.defineProperty(target, "<name>", { … })` on such a target,
 *     with pure descriptor values and getters of the form
 *     `function () { return <pure>; }`;
 *   - import declarations of admitted files and allowlisted builtins;
 *     export declarations of the above; `export default <pure>`;
 *     `export … from` of admitted files.
 *
 * Pure expressions: literals (also regular expressions and templates with
 * pure parts), identifiers bound in the file, CommonJS's `require`,
 * `module`, `exports`, `__filename` and `__dirname`, and a set of global
 * constructors and namespaces (never `process`); function, arrow and
 * admitted class expressions; object and array literals of pure parts
 * (no spreads, no accessors); `require("<literal>")` of an admitted file or
 * an allowlisted builtin; member reads on required modules, allowlisted
 * globals and same-file bindings; unary and binary operators (no
 * assignments or increments) and the conditional operator over pure
 * operands; CommonJS's top-level `this`; `Symbol(…)`, `Symbol.for(…)`,
 * `Object.freeze(…)` and `Object.create(…)` over pure arguments; `new` of
 * Map, Set, WeakMap and WeakSet without arguments.
 *
 * Everything else (calls of the package's own functions, IIFEs, `this`,
 * conditionals, loops, `try`, TypeScript's and Babel's interop helpers)
 * keeps the module eager. Only strings cross this TypeScript 5 parser
 * island. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";
import type ts from "typescript5";

const require = createRequire(import.meta.url);

/** Builtins whose loading has no effect (no warnings, no state). */
const PURE_BUILTINS = new Set([
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "constants",
  "crypto",
  "diagnostics_channel",
  "dns",
  "events",
  "fs",
  "fs/promises",
  "http",
  "https",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "querystring",
  "readline",
  "stream",
  "stream/promises",
  "string_decoder",
  "timers",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
]);

/** Globals a pure expression may name and read members of. */
const PURE_GLOBALS = new Set([
  "undefined",
  "NaN",
  "Infinity",
  "Object",
  "Function",
  "Array",
  "Number",
  "String",
  "Boolean",
  "Symbol",
  "BigInt",
  "Math",
  "JSON",
  "Reflect",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "Promise",
  "ArrayBuffer",
  "DataView",
  "Uint8Array",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "Uint8ClampedArray",
  "Intl",
  "TextEncoder",
  "TextDecoder",
  "URL",
  "URLSearchParams",
  "Buffer",
  "isNaN",
  "isFinite",
  "parseInt",
  "parseFloat",
  "encodeURIComponent",
  "decodeURIComponent",
]);

const CJS_GLOBALS = new Set(["require", "module", "exports", "__filename", "__dirname"]);

export type EffectGateResult =
  | { ok: true; files: string[] }
  | { ok: false; reason: string; file: string };

function isEsm(file: string): boolean {
  if (file.endsWith(".mjs")) return true;
  if (file.endsWith(".cjs")) return false;
  for (let dir = dirname(file); ;) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as {
        type?: unknown;
      };
      return pkg.type === "module";
    } catch {
      /* none here */
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

class Refusal extends Error {}

/** The static effect gate over the module at `entry` and every file it
 * loads. */
export function effectGate(entry: string): EffectGateResult {
  const parser = require("typescript5") as typeof ts;
  const done = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (done.has(file)) continue;
    done.add(file);
    try {
      checkFile(parser, file, (next) => {
        if (!done.has(next)) queue.push(next);
      });
    } catch (e) {
      if (e instanceof Refusal) return { ok: false, reason: e.message, file };
      throw e;
    }
  }
  return { ok: true, files: [...done] };
}

function checkFile(parser: typeof ts, file: string, load: (file: string) => void): void {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".json")) return;
  const esm = isEsm(file);
  const sf = parser.createSourceFile(
    file,
    text,
    parser.ScriptTarget.Latest,
    true,
    parser.ScriptKind.JS,
  );
  const SK = parser.SyntaxKind;
  const refuse = (node: ts.Node, what: string): never => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    throw new Refusal(`${what} at line ${line + 1}`);
  };

  // Top-level bindings and what they hold.
  const locals = new Map<string, "fn" | "class" | "module" | "value">();
  for (const stmt of sf.statements) {
    if (parser.isFunctionDeclaration(stmt) && stmt.name) locals.set(stmt.name.text, "fn");
    else if (parser.isClassDeclaration(stmt) && stmt.name) locals.set(stmt.name.text, "class");
    else if (parser.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        const kind =
          d.initializer !== undefined && isRequireish(d.initializer) ? "module" : "value";
        bindNames(d.name, kind);
      }
    } else if (parser.isImportDeclaration(stmt) && stmt.importClause) {
      const c = stmt.importClause;
      if (c.name) locals.set(c.name.text, "module");
      const nb = c.namedBindings;
      if (nb && parser.isNamespaceImport(nb)) locals.set(nb.name.text, "module");
      else if (nb) for (const el of nb.elements) locals.set(el.name.text, "module");
    }
  }
  function bindNames(name: ts.BindingName, kind: "module" | "value"): void {
    if (parser.isIdentifier(name)) locals.set(name.text, kind);
    else
      for (const el of name.elements) if (!parser.isOmittedExpression(el)) bindNames(el.name, kind);
  }
  function isRequireish(e: ts.Expression): boolean {
    while (parser.isPropertyAccessExpression(e) || parser.isParenthesizedExpression(e))
      e = e.expression;
    return (
      parser.isCallExpression(e) &&
      parser.isIdentifier(e.expression) &&
      e.expression.text === "require"
    );
  }

  const resolveSpec = (spec: string, node: ts.Node, kind: "require" | "import"): void => {
    if (isBuiltin(spec)) {
      const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
      if (!PURE_BUILTINS.has(bare)) refuse(node, `a load of the builtin '${spec}'`);
      return;
    }
    let target: string;
    if (kind === "import") {
      if (!spec.startsWith(".") && !spec.startsWith("/"))
        refuse(node, `an import of the package '${spec}' from an ES module`);
      target = resolve(dirname(file), spec);
      if (!existsSync(target)) refuse(node, `an import of '${spec}', which does not exist`);
    } else {
      try {
        target = createRequire(file).resolve(spec);
      } catch {
        return refuse(node, `a require of '${spec}', which does not resolve`);
      }
    }
    try {
      target = realpathSync(target);
    } catch {
      /* keep */
    }
    if (!/\.(?:c?js|mjs|json)$/.test(target)) refuse(node, `a load of '${spec}' (not JavaScript)`);
    load(target);
  };

  const knownIdent = (name: string): boolean =>
    locals.has(name) || PURE_GLOBALS.has(name) || (!esm && CJS_GLOBALS.has(name));

  /** A member-read receiver whose reads cannot run unknown code. */
  const readable = (e: ts.Expression): boolean => {
    if (parser.isParenthesizedExpression(e)) return readable(e.expression);
    if (parser.isIdentifier(e)) {
      const kind = locals.get(e.text);
      if (kind !== undefined) return true;
      return PURE_GLOBALS.has(e.text) || (!esm && (e.text === "module" || e.text === "exports"));
    }
    if (parser.isPropertyAccessExpression(e)) return readable(e.expression);
    if (e.kind === SK.ThisKeyword) return !esm;
    if (parser.isCallExpression(e)) return isRequireCall(e);
    return false;
  };

  const isRequireCall = (e: ts.CallExpression): boolean =>
    !esm &&
    parser.isIdentifier(e.expression) &&
    e.expression.text === "require" &&
    !locals.has("require") &&
    e.arguments.length === 1 &&
    parser.isStringLiteralLike(e.arguments[0]!);

  const pure = (e: ts.Expression): void => {
    switch (e.kind) {
      case SK.NumericLiteral:
      case SK.BigIntLiteral:
      case SK.StringLiteral:
      case SK.NoSubstitutionTemplateLiteral:
      case SK.RegularExpressionLiteral:
      case SK.TrueKeyword:
      case SK.FalseKeyword:
      case SK.NullKeyword:
        return;
      case SK.Identifier:
        if (!knownIdent((e as ts.Identifier).text))
          refuse(e, `a read of the global '${(e as ts.Identifier).text}'`);
        return;
      case SK.ParenthesizedExpression:
        return pure((e as ts.ParenthesizedExpression).expression);
      case SK.FunctionExpression:
      case SK.ArrowFunction:
        return;
      case SK.ThisKeyword:
        // CommonJS: `exports` (tsc's `this && this.__importDefault`).
        if (esm) refuse(e, "`this` in an ES module");
        return;
      case SK.ClassExpression:
        return checkClass(e as ts.ClassExpression);
      case SK.TemplateExpression:
        for (const span of (e as ts.TemplateExpression).templateSpans) pure(span.expression);
        return;
      case SK.ObjectLiteralExpression:
        for (const p of (e as ts.ObjectLiteralExpression).properties) {
          if (parser.isPropertyAssignment(p)) {
            if (parser.isComputedPropertyName(p.name)) pure(p.name.expression);
            pure(p.initializer);
          } else if (parser.isShorthandPropertyAssignment(p)) {
            pure(p.name);
          } else if (parser.isMethodDeclaration(p)) {
            if (parser.isComputedPropertyName(p.name)) pure(p.name.expression);
          } else {
            refuse(p, "a spread or accessor in an object literal");
          }
        }
        return;
      case SK.ArrayLiteralExpression:
        for (const el of (e as ts.ArrayLiteralExpression).elements) {
          if (parser.isSpreadElement(el)) refuse(el, "a spread in an array literal");
          if (!parser.isOmittedExpression(el)) pure(el);
        }
        return;
      case SK.PropertyAccessExpression: {
        const pa = e as ts.PropertyAccessExpression;
        if (pa.questionDotToken === undefined && readable(pa.expression)) {
          if (parser.isCallExpression(pa.expression)) pure(pa.expression);
          return;
        }
        return refuse(e, "a member read");
      }
      case SK.TypeOfExpression: {
        const operand = (e as ts.TypeOfExpression).expression;
        // typeof of an undeclared name does not throw.
        if (parser.isIdentifier(operand)) return;
        return pure(operand);
      }
      case SK.VoidExpression:
        return pure((e as ts.VoidExpression).expression);
      case SK.PrefixUnaryExpression: {
        const u = e as ts.PrefixUnaryExpression;
        if (u.operator === SK.PlusPlusToken || u.operator === SK.MinusMinusToken)
          return refuse(e, "an increment");
        return pure(u.operand);
      }
      case SK.BinaryExpression: {
        const b = e as ts.BinaryExpression;
        const op = b.operatorToken.kind;
        if (
          op === SK.EqualsEqualsEqualsToken ||
          op === SK.ExclamationEqualsEqualsToken ||
          op === SK.AmpersandAmpersandToken ||
          op === SK.BarBarToken ||
          op === SK.QuestionQuestionToken ||
          op === SK.CommaToken
        ) {
          pure(b.left);
          pure(b.right);
          return;
        }
        if (op >= SK.FirstAssignment && op <= SK.LastAssignment)
          return refuse(e, "an assignment inside an expression");
        // Coercions of pure operands; a module-defined valueOf/toString
        // runs module code, whose effects the probe's recording sees.
        pure(b.left);
        pure(b.right);
        return;
      }
      case SK.ConditionalExpression: {
        const c = e as ts.ConditionalExpression;
        pure(c.condition);
        pure(c.whenTrue);
        pure(c.whenFalse);
        return;
      }
      case SK.CallExpression: {
        const call = e as ts.CallExpression;
        if (isRequireCall(call)) {
          resolveSpec((call.arguments[0] as ts.StringLiteral).text, call, "require");
          return;
        }
        const callee = call.expression;
        if (
          call.questionDotToken === undefined &&
          parser.isPropertyAccessExpression(callee) &&
          parser.isIdentifier(callee.expression) &&
          !locals.has(callee.expression.text)
        ) {
          const name = `${callee.expression.text}.${callee.name.text}`;
          if (name === "Symbol.for" || name === "Object.freeze" || name === "Object.create") {
            for (const a of call.arguments) pure(a);
            return;
          }
        }
        if (parser.isIdentifier(callee) && callee.text === "Symbol" && !locals.has("Symbol")) {
          for (const a of call.arguments) pure(a);
          return;
        }
        return refuse(e, "a call");
      }
      case SK.NewExpression: {
        const n = e as ts.NewExpression;
        if (
          parser.isIdentifier(n.expression) &&
          ["Map", "Set", "WeakMap", "WeakSet"].includes(n.expression.text) &&
          !locals.has(n.expression.text) &&
          (n.arguments === undefined || n.arguments.length === 0)
        )
          return;
        return refuse(e, "a `new` expression");
      }
      default:
        return refuse(e, `a ${parser.SyntaxKind[e.kind]} expression`);
    }
  };

  const isLiteral = (e: ts.Expression): boolean =>
    e.kind === SK.NumericLiteral ||
    e.kind === SK.StringLiteral ||
    e.kind === SK.NoSubstitutionTemplateLiteral ||
    e.kind === SK.TrueKeyword ||
    e.kind === SK.FalseKeyword ||
    e.kind === SK.NullKeyword ||
    (parser.isPrefixUnaryExpression(e) && e.operator === SK.MinusToken && isLiteral(e.operand)) ||
    (parser.isParenthesizedExpression(e) && isLiteral(e.expression));

  function checkClass(c: ts.ClassLikeDeclaration): void {
    const decorated = parser.canHaveDecorators(c) && (parser.getDecorators(c)?.length ?? 0) > 0;
    if (decorated) refuse(c, "a decorated class");
    for (const h of c.heritageClauses ?? []) for (const t of h.types) pure(t.expression);
    for (const m of c.members) {
      if (parser.isClassStaticBlockDeclaration(m)) refuse(m, "a class static block");
      if (parser.canHaveDecorators(m) && (parser.getDecorators(m)?.length ?? 0) > 0)
        refuse(m, "a decorated class member");
      if (m.name !== undefined && parser.isComputedPropertyName(m.name)) pure(m.name.expression);
      const isStatic =
        parser.canHaveModifiers(m) &&
        (parser.getModifiers(m) ?? []).some((x) => x.kind === SK.StaticKeyword);
      if (isStatic && parser.isPropertyDeclaration(m) && m.initializer !== undefined)
        pure(m.initializer);
    }
  }

  /** The root binding of an assignment target, when the write is allowed. */
  const writable = (target: ts.Expression): boolean => {
    if (!parser.isPropertyAccessExpression(target) && !parser.isElementAccessExpression(target))
      return false;
    if (parser.isElementAccessExpression(target)) {
      if (!isLiteral(target.argumentExpression)) return false;
    }
    let root: ts.Expression = target.expression;
    // module.exports / module.exports.x
    if (!esm && parser.isIdentifier(root) && root.text === "module" && !locals.has("module")) {
      return parser.isPropertyAccessExpression(target) && target.name.text === "exports";
    }
    while (parser.isPropertyAccessExpression(root)) root = root.expression;
    if (!parser.isIdentifier(root)) return false;
    if (!esm && (root.text === "exports" || root.text === "module") && !locals.has(root.text)) {
      if (root.text === "module") {
        // module.exports.x…
        let e: ts.Expression = target.expression;
        while (
          parser.isPropertyAccessExpression(e) &&
          parser.isPropertyAccessExpression(e.expression)
        )
          e = e.expression;
        return parser.isPropertyAccessExpression(e) && e.name.text === "exports";
      }
      return true;
    }
    const kind = locals.get(root.text);
    return kind === "fn" || kind === "class" || kind === "value";
  };

  const definePropertyTarget = (e: ts.Expression): boolean => {
    if (parser.isIdentifier(e)) {
      if (!esm && e.text === "exports" && !locals.has("exports")) return true;
      const kind = locals.get(e.text);
      return kind === "fn" || kind === "class" || kind === "value";
    }
    return (
      !esm &&
      parser.isPropertyAccessExpression(e) &&
      parser.isIdentifier(e.expression) &&
      e.expression.text === "module" &&
      e.name.text === "exports"
    );
  };

  const checkDescriptor = (d: ts.Expression): void => {
    if (!parser.isObjectLiteralExpression(d)) return refuse(d, "a computed property descriptor");
    for (const p of d.properties) {
      if (!parser.isPropertyAssignment(p) || !parser.isIdentifier(p.name))
        return refuse(p, "an unusual property descriptor");
      const key = p.name.text;
      if (key === "get") {
        const f = p.initializer;
        const body =
          parser.isFunctionExpression(f) || parser.isArrowFunction(f) ? f.body : undefined;
        if (body === undefined) return refuse(p, "a getter that is not a function literal");
        if (parser.isBlock(body)) {
          const only = body.statements[0];
          if (
            body.statements.length !== 1 ||
            only === undefined ||
            !parser.isReturnStatement(only) ||
            only.expression === undefined
          )
            return refuse(p, "a getter with more than `return <expression>`");
          pure(only.expression);
        } else {
          pure(body);
        }
      } else if (
        key === "value" ||
        key === "enumerable" ||
        key === "configurable" ||
        key === "writable"
      ) {
        pure(p.initializer);
      } else {
        return refuse(p, `a '${key}' property descriptor`);
      }
    }
  };

  const checkStatement = (stmt: ts.Statement): void => {
    if (parser.isEmptyStatement(stmt) || parser.isFunctionDeclaration(stmt)) return;
    if (parser.isClassDeclaration(stmt)) return checkClass(stmt);
    if (parser.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!parser.isIdentifier(d.name)) {
          // Destructuring reads members: only of required modules, without
          // defaults.
          if (d.initializer === undefined || !isRequireish(d.initializer))
            refuse(d, "destructuring of a value other than a required module");
          const noDefaults = (n: ts.BindingName): boolean =>
            parser.isIdentifier(n) ||
            n.elements.every(
              (el) =>
                parser.isOmittedExpression(el) ||
                (el.initializer === undefined &&
                  el.dotDotDotToken === undefined &&
                  noDefaults(el.name)),
            );
          if (!noDefaults(d.name)) refuse(d, "a destructuring default or rest element");
        }
        if (d.initializer !== undefined) pure(d.initializer);
      }
      return;
    }
    if (parser.isExpressionStatement(stmt)) {
      const e = stmt.expression;
      if (parser.isStringLiteral(e)) return; // directive
      if (parser.isBinaryExpression(e) && e.operatorToken.kind === SK.EqualsToken) {
        if (!writable(e.left)) return refuse(e, "an assignment outside the module's own objects");
        pure(e.right);
        return;
      }
      if (parser.isCallExpression(e)) {
        const callee = e.expression;
        if (
          parser.isPropertyAccessExpression(callee) &&
          parser.isIdentifier(callee.expression) &&
          callee.expression.text === "Object" &&
          !locals.has("Object") &&
          callee.name.text === "defineProperty" &&
          e.arguments.length === 3 &&
          definePropertyTarget(e.arguments[0]!) &&
          parser.isStringLiteralLike(e.arguments[1]!)
        ) {
          checkDescriptor(e.arguments[2]!);
          return;
        }
        if (isRequireCall(e)) {
          pure(e);
          return;
        }
      }
      return refuse(stmt, "a top-level expression with possible effects");
    }
    if (parser.isImportDeclaration(stmt)) {
      if (stmt.attributes !== undefined) refuse(stmt, "an import with attributes");
      resolveSpec((stmt.moduleSpecifier as ts.StringLiteral).text, stmt, "import");
      return;
    }
    if (parser.isExportDeclaration(stmt)) {
      if (stmt.moduleSpecifier !== undefined)
        resolveSpec((stmt.moduleSpecifier as ts.StringLiteral).text, stmt, "import");
      return;
    }
    if (parser.isExportAssignment(stmt)) return pure(stmt.expression);
    return refuse(stmt, `a top-level ${parser.SyntaxKind[stmt.kind]}`);
  };

  for (const stmt of sf.statements) checkStatement(stmt);
}
