/* Node's CommonJS named-export DETECTABILITY test — the compile-time
 * answer to "which names can `import { x } from './cjs.js'` actually
 * link?". Node never executes a CJS module to build its ESM facade: it
 * lexes the source with its vendored CJS lexer (Node v24.15.0 vendors
 * deps/merve, the native `cjs_lexer` binding that replaced the
 * cjs-module-lexer wasm build; the detection patterns are FROZEN by
 * upstream policy) and only the names that lexer detects become named
 * exports. The checker sees the real export table, so it happily binds
 * names the lexer cannot see — `module.exports = { a: 7 }` type-checks a
 * named import of `a` that Node refuses at link time with a SyntaxError.
 * This module mirrors merve's detection so the compiler can answer
 * exactly what Node answers — for the program's own CJS files (program.ts
 * gates the ESM instantiate graph) AND for the --dynamic island's embedded
 * npm modules (npm.ts synthesizes each CJS facade from this lexer, so an
 * embedded named import fails exactly where Node's would).
 *
 * INPUT IS SOURCE TEXT. merve is a byte lexer; this port parses the text
 * with the 5.9.3 island parser and walks the AST, reading the raw source
 * wherever merve's byte quirks demand it. Only strings and name sets cross
 * this module's boundary — no AST object from either typescript world —
 * which is what lets both the 7.0.2-world program preflight and the
 * typescript5-world npm scan share the one implementation.
 *
 * The port is deliberately quirk-faithful — these all match probed Node
 * v24.15.0 behavior, not what a clean reimplementation would choose:
 *  - `module.exports = { ... }` props scan LEFT TO RIGHT and the scan
 *    STOPS at the first prop it cannot shape — names added before the
 *    stop are kept, everything after is invisible. `{ vis: v, lit: 7 }`
 *    exports `vis` only; `{ lit: 7, vis: v }` exports nothing.
 *  - A prop VALUE must start with an identifier-ish token (an identifier,
 *    keyword, `require(...)` call — anything whose first character is
 *    [A-Za-z_$] or non-ASCII). Literals (`7`, `"s"`, backticks, arrows'
 *    `(`) stop the scan WITHOUT adding the key.
 *  - After an accepted value the lexer consumes ONE identifier run and
 *    requires the very next CHARACTER to be `,` or `}` — `a: b, c: d`
 *    keeps both, `a: b , c: d` keeps only `a` (the space stops the scan),
 *    `a: o.x` / `a: f()` keep `a` and stop.
 *  - A `require('spec')` VALUE adds the key, records the spec as a
 *    REEXPORT, and stops the scan unconditionally — `{ a: require('x'),
 *    b: v }` exports `a` plus x's names, never `b`. Trailing tokens on the
 *    require (`.foo`, `()`, `|| y`) change nothing.
 *  - `get name() {...}` stops the scan cold (no add); `set name(v) {}`
 *    adds the literal name "set" and stops; `async name() {}` adds
 *    "async" and stops; a plain method `name() {}` adds `name` and stops.
 *  - `exports.NAME = ` / `module.exports.NAME = ` / the ['string'] forms
 *    match ANYWHERE in the file — nested functions, dead branches — with
 *    no scope analysis, and nothing ever removes a detected name.
 *  - `module.exports = require('./x')` records a REEXPORT whenever the
 *    require call is the LEADING token of the right-hand side — trailers
 *    (`.foo`, `()`, `|| {}`, `? a : b`) are ignored, but a leading `(`
 *    breaks the match (`(require('x'))` records nothing). Node resolves
 *    each reexport and unions the target's detected names when the target
 *    is itself CommonJS. Every `module.exports =` assignment CLEARS the
 *    pending reexport list first — including star-pattern reexports
 *    recorded earlier — so only reexports at or after the last assignment
 *    count, while detected export NAMES accumulate across everything.
 *  - `Object.defineProperty(exports, 'n', {...})` adds `n` for the exact
 *    descriptor shapes merve accepts: optional leading `enumerable: true`
 *    then `value:` (anything), or a getter whose whole body is `return
 *    IDENT` / `return IDENT.IDENT` / `return IDENT['str']` and which is
 *    the descriptor's last property. Unlike cjs-module-lexer 2.2.0, a
 *    NON-matching defineProperty of the same name elsewhere does NOT
 *    poison the valid one (probed: Node keeps the export).
 *  - The transpiler star-reexport patterns ARE detected (tsc/babel output
 *    all over npm depends on them):
 *      · `__export(require('x'))` / `__exportStar(require('x'), exports)`
 *        — callee is the bare identifier or any member chain ending in
 *        one of those two exact names, at TOP LEVEL (brace depth 0 — an
 *        unbraced `if (c) __exportStar(...)` still counts, a braced block
 *        does not), and the source bytes must read `NAME(require` with NO
 *        whitespace or comment between the name, the `(`, and `require`
 *        (probed: one space kills the match; spaces anywhere inside the
 *        require call are fine).
 *      · The Babel copy loop: a top-level `var/const/let ID =
 *        [_interopRequireWildcard(]require('x')[)]` (ID the FIRST
 *        declarator; `_interopRequireWildcard` bare and byte-adjacent to
 *        `(require` like the star form) linked by ID to a top-level
 *        `Object.keys(ID).forEach(function (KEY) {...})` whose body is
 *        byte-for-byte one of merve's copy shapes: the `if (KEY ===
 *        'default' || KEY === '__esModule') return;` filter (exact order,
 *        unbraced return) with optional hasOwnProperty / in-exports
 *        guards, or the single `if (KEY !== 'default' [&& !hasOwn]) copy`
 *        form; the copy either `EXPORTS[KEY] = ID[KEY]` or the
 *        enumerable-getter defineProperty. Named callbacks, arrow
 *        callbacks, braced returns, and reordered filters all miss.
 *        The reexport's clearing position is the LOOP's, not the var's.
 * NOT modeled: cjs-module-lexer 2.2.0's phantom "get" export for an
 * identifier-named getter in the table (`{ get a() {} }` exports nothing
 * in Node — but `get [k]() {}` / `get "a"() {}` DO export the word "get",
 * because the name token stops the lexer after it took `get` as a
 * shorthand key). */

import ts from "typescript5";

export interface CjsLexedExports {
  /** Names Node's lexer detects in THIS file (no reexport resolution). */
  exports: Set<string>;
  /** Reexport specifiers surviving the last `module.exports =` clearing,
   * in source order: the assignment's own require forms plus every later
   * (or unclear-ed) star-pattern / Babel-loop match. */
  reexports: string[];
}

/** merve's byte classification: [A-Za-z_$] plus every non-ASCII byte. */
function isIdentStartChar(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch) || ch.charCodeAt(0) > 127;
}

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) > 127;
}

/** End of the identifier run starting at `pos` (merve consumes maximal
 * identifier characters and nothing else — no member chains, no calls). */
function identRunEnd(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && isIdentChar(text[i]!)) i++;
  return i;
}

/** True when the node's SOURCE spelling starts like a lexer identifier —
 * a `a`-escaped name parses to the same AST as its plain spelling,
 * but merve reads bytes and stops at the backslash. */
function sourceSpellsIdentifier(node: ts.Node, sf: ts.SourceFile): boolean {
  const ch = sf.text[node.getStart(sf)];
  return ch !== undefined && isIdentStartChar(ch);
}

/** True when the node's WHOLE source span is one identifier run — what
 * merve takes for IDENT. Keywords count (`return this.x` satisfies the
 * defineProperty getter's `return IDENT.IDENT` because `this` lexes as an
 * identifier run — probed), escapes and private names do not. */
function isIdentTokenNode(node: ts.Node, sf: ts.SourceFile): boolean {
  const start = node.getStart(sf);
  const ch = sf.text[start];
  return ch !== undefined && isIdentStartChar(ch) && identRunEnd(sf.text, start) === node.getEnd();
}

/** The identifier run at the node's START — the whole name when its
 * spelling is plain, the byte prefix merve consumed when a unicode escape
 * interrupts the run mid-name. */
function identPrefixOf(node: ts.Node, sf: ts.SourceFile): string {
  const start = node.getStart(sf);
  return sf.text.slice(start, identRunEnd(sf.text, start));
}

/** The bare `require('spec')` call merve recognizes. */
export function bareRequireSpecOf(e: ts.Node): string | null {
  if (!ts.isCallExpression(e) || e.questionDotToken !== undefined) return null;
  if (!ts.isIdentifier(e.expression) || e.expression.text !== "require") return null;
  if (e.arguments.length !== 1) return null;
  const arg = e.arguments[0]!;
  return ts.isStringLiteral(arg) ? arg.text : null;
}

/** True when `e` is exactly the `exports` identifier. */
export function isExportsIdent(e: ts.Expression): boolean {
  return ts.isIdentifier(e) && e.text === "exports";
}

/** True when `e` is exactly `module.exports`. */
export function isModuleExports(e: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(e) &&
    e.questionDotToken === undefined &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "module" &&
    ts.isIdentifier(e.name) &&
    e.name.text === "exports"
  );
}

/** The `require(...)` call at the very START of `e`'s source span, if any:
 * merve records the reexport as soon as it lexes `require('spec')` and any
 * TRAILER (`.foo`, `()`, `|| y`, `? a : b`) merely stops whatever scan
 * follows — so the recognizer descends the leftmost-child chain while it
 * still starts where `e` starts. A ParenthesizedExpression breaks the
 * chain naturally (its child starts after the `(`), matching merve. */
function leadingRequireOf(e: ts.Expression, sf: ts.SourceFile): { spec: string; end: number } | null {
  const start = e.getStart(sf);
  let cur: ts.Node = e;
  for (;;) {
    const spec = bareRequireSpecOf(cur);
    if (spec !== null && cur.getStart(sf) === start) return { spec, end: cur.getEnd() };
    let first: ts.Node | undefined;
    ts.forEachChild(cur, (c) => {
      first ??= c;
    });
    if (first === undefined || first.getStart(sf) !== start) return null;
    cur = first;
  }
}

/** Skips ECMA whitespace and comments forward from `pos` (merve's
 * commentWhitespace) and answers the next meaningful character (or ""). */
function nextMeaningfulChar(text: string, pos: number): string {
  let i = pos;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === " " || (ch.charCodeAt(0) > 8 && ch.charCodeAt(0) < 14)) {
      i++;
    } else if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i + 2);
      if (nl < 0) return "";
      i = nl;
    } else if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) return "";
      i = close + 2;
    } else {
      return ch;
    }
  }
  return "";
}

/** The `module.exports = { ... }` table scan — merve's tryParseLiteralExports
 * over the AST. Adds detected names to `out`, appends reexports (spread /
 * value requires) to `reexports`, stops at the first unshapeable prop. */
function scanTableLiteral(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile, out: Set<string>, reexports: string[]): void {
  const text = sf.text;
  for (const prop of obj.properties) {
    if (ts.isGetAccessor(prop)) {
      // `get name() {...}` — merve's explicit early termination... unless
      // the accessor's NAME is not a plain identifier, where the lexer
      // already added the word "get" as a shorthand key before the odd
      // token stops it (`get [k]() {}` exports "get").
      if (!ts.isIdentifier(prop.name) || !sourceSpellsIdentifier(prop.name, sf)) out.add("get");
      return;
    }
    if (ts.isSetAccessor(prop)) {
      // The word `set` lexes as a shorthand key, then the accessor name
      // stops the scan — Node really does export "set" (value undefined).
      out.add("set");
      return;
    }
    if (ts.isMethodDeclaration(prop)) {
      // `name() {}` adds the name, then `(` stops the scan. The modifier /
      // asterisk spellings shift which token the lexer takes as the key:
      // `async name()` exports "async", `*name()` exports nothing. A
      // unicode escape mid-name adds only the byte prefix before it (the
      // key adds BEFORE the separator check fails — see the key path).
      if (prop.asteriskToken !== undefined) return;
      const mods = ts.getModifiers(prop) ?? [];
      if (mods.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
        out.add("async");
        return;
      }
      if (ts.isIdentifier(prop.name) && sourceSpellsIdentifier(prop.name, sf)) out.add(identPrefixOf(prop.name, sf));
      return;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      if (prop.objectAssignmentInitializer !== undefined) return; // `{ a = 1 }` — cover pattern, not a table
      if (!ts.isIdentifier(prop.name) || !sourceSpellsIdentifier(prop.name, sf)) return;
      if (!isIdentTokenNode(prop.name, sf)) {
        // an escape mid-name: the byte prefix adds, then the backslash
        // fails the separator check and stops the scan
        out.add(identPrefixOf(prop.name, sf));
        return;
      }
      out.add(prop.name.text);
      continue; // whitespace before `,` is skipped on the shorthand path
    }
    if (ts.isSpreadAssignment(prop)) {
      const req = leadingRequireOf(prop.expression, sf);
      let consumedEnd: number;
      if (req !== null) {
        reexports.push(req.spec);
        consumedEnd = req.end;
      } else if (sourceSpellsIdentifier(prop.expression, sf)) {
        consumedEnd = identRunEnd(text, prop.expression.getStart(sf));
      } else {
        return; // `...{}` and friends stop the scan
      }
      // The spread path DOES skip whitespace/comments before the `,` check
      // — `...o , a: b` continues where `a: b , c` would stop.
      const ch = nextMeaningfulChar(text, consumedEnd);
      if (ch === ",") continue;
      return; // `...o.p`, `...f()` — the leftover token stops the scan
              // (a `}` here means the spread was last; stopping is the same)
    }
    if (ts.isPropertyAssignment(prop)) {
      const name = prop.name;
      let key: string | null = null;
      if (ts.isIdentifier(name) && sourceSpellsIdentifier(name, sf)) {
        if (!isIdentTokenNode(name, sf)) {
          // merve adds the key BEFORE validating the `:` — an escape
          // mid-name adds the byte prefix, then the backslash stops the
          // scan (probed: the key's prefix exports, nothing after does)
          out.add(identPrefixOf(name, sf));
          return;
        }
        key = name.text;
      } else if (ts.isStringLiteral(name)) {
        key = name.text;
      }
      if (key === null) return; // numeric / computed / template keys stop the scan
      const value = prop.initializer;
      const req = leadingRequireOf(value, sf);
      if (req !== null) {
        // A require VALUE adds the key, records the reexport, and stops
        // the scan UNCONDITIONALLY — probed: `{ a: require('x'), b: v }`
        // exports `a` plus x's names and never `b` (the spread path above
        // genuinely continues past a `,`; the value path does not).
        out.add(key);
        reexports.push(req.spec);
        return;
      }
      const start = value.getStart(sf);
      const ch0 = text[start];
      if (ch0 === undefined || !isIdentStartChar(ch0)) return; // literal values stop WITHOUT adding the key
      const consumedEnd = identRunEnd(text, start);
      out.add(key);
      // NO whitespace skip here — merve requires `,` or `}` as the very
      // next character after the consumed value token. `a: b , c` and
      // `a: b.c, d` both keep `a` and stop.
      const ch = text[consumedEnd];
      if (ch === ",") continue;
      return; // `}` ends the props anyway; anything else stops the scan
    }
    return; // any other prop kind stops the scan
  }
}

/** `Object.defineProperty(exports|module.exports, 'name', {...})` — adds
 * the name for merve's exact descriptor shapes (see the header). */
function scanDefineProperty(call: ts.CallExpression, sf: ts.SourceFile, out: Set<string>): void {
  const callee = call.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.questionDotToken !== undefined ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Object" ||
    !ts.isIdentifier(callee.name) ||
    callee.name.text !== "defineProperty"
  ) {
    return;
  }
  if (call.arguments.length !== 3) return;
  const [recv, nameArg, desc] = call.arguments as unknown as [ts.Expression, ts.Expression, ts.Expression];
  if (!isExportsIdent(recv) && !isModuleExports(recv)) return;
  if (!ts.isStringLiteral(nameArg)) return;
  if (!ts.isObjectLiteralExpression(desc)) return;
  let i = 0;
  const props = desc.properties;
  const first = props[0];
  if (
    first !== undefined &&
    ts.isPropertyAssignment(first) &&
    ts.isIdentifier(first.name) &&
    first.name.text === "enumerable"
  ) {
    // Only the exact `enumerable: true` prefix is consumed; anything else
    // in the slot fails the whole match.
    if (first.initializer.kind !== ts.SyntaxKind.TrueKeyword) return;
    i = 1;
  }
  const p = props[i];
  if (p === undefined) return;
  if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "value") {
    out.add(nameArg.text); // merve stops right at `value:` — the value and the rest of the descriptor are unchecked
    return;
  }
  // The getter forms: `get() {...}` method, or `get: function [name]() {...}`
  // (never an arrow), body EXACTLY `return IDENT` / IDENT.IDENT / IDENT['s'],
  // and the getter must be the descriptor's LAST property.
  const body = getterBodyOf(p);
  if (body === undefined || i !== props.length - 1) return;
  if (body.statements.length !== 1) return;
  const ret = body.statements[0]!;
  if (!ts.isReturnStatement(ret) || ret.expression === undefined) return;
  const r = ret.expression;
  const returnsIdentish =
    isIdentTokenNode(r, sf) ||
    (ts.isPropertyAccessExpression(r) && r.questionDotToken === undefined && isIdentTokenNode(r.expression, sf) && isIdentTokenNode(r.name, sf)) ||
    (ts.isElementAccessExpression(r) && r.questionDotToken === undefined && isIdentTokenNode(r.expression, sf) && ts.isStringLiteral(r.argumentExpression));
  if (returnsIdentish) out.add(nameArg.text);
}

/** The body of a `get() {...}` method / `get: function [name]() {...}`
 * descriptor prop (merve's two getter spellings — arrows never match). */
function getterBodyOf(p: ts.ObjectLiteralElementLike): ts.Block | undefined {
  if (
    ts.isMethodDeclaration(p) &&
    ts.isIdentifier(p.name) &&
    p.name.text === "get" &&
    p.asteriskToken === undefined &&
    (ts.getModifiers(p) ?? []).length === 0 &&
    p.parameters.length === 0
  ) {
    return p.body;
  }
  if (
    ts.isPropertyAssignment(p) &&
    ts.isIdentifier(p.name) &&
    p.name.text === "get" &&
    ts.isFunctionExpression(p.initializer) &&
    p.initializer.parameters.length === 0 &&
    p.initializer.asteriskToken === undefined &&
    (ts.getModifiers(p.initializer) ?? []).length === 0
  ) {
    return p.initializer.body;
  }
  return undefined;
}

/* ── the transpiler star-reexport patterns ─────────────────────────────── */

/** The star-export call: callee is `__export` or `__exportStar` (bare, or
 * the NAME of any member chain — `tslib_1.__exportStar`, `a.b.__exportStar`)
 * and the first argument leads with `require('spec')`. Byte quirk: the
 * source must read `NAME(require` with no trivia between the name, the
 * `(`, and `require` — one space anywhere in that seam kills the match
 * (probed; spaces INSIDE the require call are fine). */
function starExportSpecOf(call: ts.CallExpression, sf: ts.SourceFile): string | null {
  if (call.questionDotToken !== undefined) return null;
  const callee = call.expression;
  let nameNode: ts.Identifier | undefined;
  if (ts.isIdentifier(callee)) nameNode = callee;
  else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) nameNode = callee.name;
  if (nameNode === undefined) return null;
  if (nameNode.text !== "__export" && nameNode.text !== "__exportStar") return null;
  if (!sourceSpellsIdentifier(nameNode, sf)) return null;
  const arg0 = call.arguments[0];
  if (arg0 === undefined) return null;
  if (!byteAdjacentParen(sf, nameNode.getEnd(), arg0.getStart(sf))) return null;
  return leadingRequireOf(arg0, sf)?.spec ?? null;
}

/** True when the bytes between a callee name ending at `nameEnd` and its
 * first argument starting at `argStart` are exactly `(` — merve's anchored
 * `NAME(require` seam. */
function byteAdjacentParen(sf: ts.SourceFile, nameEnd: number, argStart: number): boolean {
  return argStart === nameEnd + 1 && sf.text[nameEnd] === "(";
}

/** The Babel star-copy assignment: a variable statement whose FIRST
 * declarator is `ID = require('spec')` or
 * `ID = _interopRequireWildcard(require('spec'))` (the wildcard helper a
 * bare identifier, byte-adjacent to `(require` like the star form —
 * probed: a member-qualified helper or one space after its paren misses).
 * Answers [ID, spec]. */
function starAssignOf(stmt: ts.VariableStatement, sf: ts.SourceFile): [string, string] | null {
  const decl = stmt.declarationList.declarations[0];
  if (decl === undefined || !ts.isIdentifier(decl.name) || !sourceSpellsIdentifier(decl.name, sf)) return null;
  const init = decl.initializer;
  if (init === undefined) return null;
  const direct = bareRequireSpecOf(init);
  if (direct !== null) return [decl.name.text, direct];
  if (
    ts.isCallExpression(init) &&
    init.questionDotToken === undefined &&
    ts.isIdentifier(init.expression) &&
    init.expression.text === "_interopRequireWildcard" &&
    init.arguments.length >= 1
  ) {
    const arg0 = init.arguments[0]!;
    if (!byteAdjacentParen(sf, init.expression.getEnd(), arg0.getStart(sf))) return null;
    const spec = bareRequireSpecOf(arg0);
    if (spec !== null) return [decl.name.text, spec];
  }
  return null;
}

/** `exports` / `module.exports` — the copy loop accepts either spelling. */
function isExportsTarget(e: ts.Expression): boolean {
  return isExportsIdent(e) || isModuleExports(e);
}

/** `X === 'str'` / `X !== 'str'` with X the loop key identifier. */
function keyStringCompare(e: ts.Expression, key: string, op: ts.SyntaxKind, str: string): boolean {
  return (
    ts.isBinaryExpression(e) &&
    e.operatorToken.kind === op &&
    ts.isIdentifier(e.left) &&
    e.left.text === key &&
    ts.isStringLiteral(e.right) &&
    e.right.text === str
  );
}

/** `Object[.prototype].hasOwnProperty.call(ANY_ID, KEY)` — the guard merve
 * accepts in both loop filter forms. */
function isHasOwnCall(e: ts.Expression, key: string): boolean {
  if (!ts.isCallExpression(e) || e.questionDotToken !== undefined) return false;
  const callee = e.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name) || callee.name.text !== "call") return false;
  let cur = callee.expression;
  if (!ts.isPropertyAccessExpression(cur) || !ts.isIdentifier(cur.name) || cur.name.text !== "hasOwnProperty") return false;
  cur = cur.expression;
  if (ts.isPropertyAccessExpression(cur) && ts.isIdentifier(cur.name) && cur.name.text === "prototype") cur = cur.expression;
  if (!ts.isIdentifier(cur) || cur.text !== "Object") return false;
  if (e.arguments.length !== 2) return false;
  const [recv, k] = e.arguments as unknown as [ts.Expression, ts.Expression];
  return ts.isIdentifier(recv) && ts.isIdentifier(k) && k.text === key;
}

/** `ID.hasOwnProperty(KEY)` — form B's alternative hasOwn spelling. */
function isDirectHasOwnCall(e: ts.Expression, key: string): boolean {
  return (
    ts.isCallExpression(e) &&
    e.questionDotToken === undefined &&
    ts.isPropertyAccessExpression(e.expression) &&
    ts.isIdentifier(e.expression.name) &&
    e.expression.name.text === "hasOwnProperty" &&
    ts.isIdentifier(e.expression.expression) &&
    e.arguments.length === 1 &&
    ts.isIdentifier(e.arguments[0]!) &&
    (e.arguments[0] as ts.Identifier).text === key
  );
}

/** The loop-body COPY statement: `EXPORTS[KEY] = ID[KEY];` or the
 * enumerable-getter defineProperty (`Object.defineProperty(EXPORTS, KEY,
 * { enumerable: true, get[: function[name]] () { return ID[KEY]; } })`). */
function isCopyStatement(stmt: ts.Statement, id1: string, key: string): boolean {
  if (!ts.isExpressionStatement(stmt)) return false;
  const e = stmt.expression;
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return isKeyedAccess(e.left, isExportsTarget, key) && isKeyedAccess(e.right, (x) => ts.isIdentifier(x) && x.text === id1, key);
  }
  if (!ts.isCallExpression(e) || e.questionDotToken !== undefined) return false;
  const callee = e.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Object" ||
    !ts.isIdentifier(callee.name) ||
    callee.name.text !== "defineProperty"
  ) {
    return false;
  }
  if (e.arguments.length !== 3) return false;
  const [recv, nameArg, desc] = e.arguments as unknown as [ts.Expression, ts.Expression, ts.Expression];
  if (!isExportsTarget(recv)) return false;
  if (!ts.isIdentifier(nameArg) || nameArg.text !== key) return false;
  if (!ts.isObjectLiteralExpression(desc) || desc.properties.length !== 2) return false;
  const [en, get] = desc.properties as unknown as [ts.ObjectLiteralElementLike, ts.ObjectLiteralElementLike];
  if (!ts.isPropertyAssignment(en) || !ts.isIdentifier(en.name) || en.name.text !== "enumerable") return false;
  if (en.initializer.kind !== ts.SyntaxKind.TrueKeyword) return false;
  const body = getterBodyOf(get);
  if (body === undefined || body.statements.length !== 1) return false;
  const ret = body.statements[0]!;
  if (!ts.isReturnStatement(ret) || ret.expression === undefined) return false;
  return isKeyedAccess(ret.expression, (x) => ts.isIdentifier(x) && x.text === id1, key);
}

/** `RECV[KEY]` where `recvOk` approves the receiver. */
function isKeyedAccess(e: ts.Expression, recvOk: (x: ts.Expression) => boolean, key: string): boolean {
  return (
    ts.isElementAccessExpression(e) &&
    e.questionDotToken === undefined &&
    recvOk(e.expression) &&
    ts.isIdentifier(e.argumentExpression) &&
    e.argumentExpression.text === key
  );
}

/** An UNBRACED bare `return;` — merve reads the literal `return` token
 * right after the filter's `)`; a `{ return; }` block misses (probed). */
function isBareReturn(stmt: ts.Statement): boolean {
  return ts.isReturnStatement(stmt) && stmt.expression === undefined;
}

/** The Babel copy loop `Object.keys(ID1).forEach(function (KEY) {...})` —
 * answers ID1 when the whole shape matches merve's EXPORT_STAR_LIB
 * grammar; the caller links ID1 to a star assignment for the spec. */
function starLoopIdOf(call: ts.CallExpression, sf: ts.SourceFile): string | null {
  if (call.questionDotToken !== undefined) return null;
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken !== undefined) return null;
  if (!ts.isIdentifier(callee.name) || callee.name.text !== "forEach") return null;
  const keysCall = callee.expression;
  if (!ts.isCallExpression(keysCall) || keysCall.questionDotToken !== undefined) return null;
  const keysCallee = keysCall.expression;
  if (
    !ts.isPropertyAccessExpression(keysCallee) ||
    !ts.isIdentifier(keysCallee.expression) ||
    keysCallee.expression.text !== "Object" ||
    !ts.isIdentifier(keysCallee.name) ||
    keysCallee.name.text !== "keys"
  ) {
    return null;
  }
  if (keysCall.arguments.length !== 1) return null;
  const id1Node = keysCall.arguments[0]!;
  if (!ts.isIdentifier(id1Node) || !sourceSpellsIdentifier(id1Node, sf)) return null;
  const id1 = id1Node.text;
  const fn = call.arguments[0];
  if (fn === undefined || !ts.isFunctionExpression(fn)) return null; // arrows never match (probed)
  if (fn.name !== undefined) return null; // a NAMED callback misses (probed)
  if (fn.asteriskToken !== undefined || (ts.getModifiers(fn) ?? []).length > 0) return null;
  if (fn.parameters.length !== 1) return null;
  const keyParam = fn.parameters[0]!;
  if (!ts.isIdentifier(keyParam.name) || keyParam.initializer !== undefined || keyParam.dotDotDotToken !== undefined) return null;
  const key = keyParam.name.text;
  const stmts = fn.body.statements;

  // Form B: the single `if (KEY !== 'default' [&& !hasOwn]) COPY` statement.
  if (stmts.length === 1 && ts.isIfStatement(stmts[0]!) && stmts[0]!.elseStatement === undefined) {
    const ifStmt = stmts[0]!;
    let cond = ifStmt.expression;
    if (ts.isBinaryExpression(cond) && cond.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      const right = cond.right;
      if (
        !ts.isPrefixUnaryExpression(right) ||
        right.operator !== ts.SyntaxKind.ExclamationToken ||
        !(isHasOwnCall(right.operand, key) || isDirectHasOwnCall(right.operand, key))
      ) {
        return null;
      }
      cond = cond.left;
    }
    if (!keyStringCompare(cond, key, ts.SyntaxKind.ExclamationEqualsEqualsToken, "default")) return null;
    return isCopyStatement(ifStmt.thenStatement, id1, key) ? id1 : null;
  }

  // Form A: `if (KEY === 'default' || KEY === '__esModule') return;` (exact
  // order), then optional hasOwn / in-exports guards, then the copy.
  if (stmts.length < 2 || stmts.length > 4) return null;
  const head = stmts[0]!;
  if (!ts.isIfStatement(head) || head.elseStatement !== undefined || !isBareReturn(head.thenStatement)) return null;
  const headCond = head.expression;
  if (
    !ts.isBinaryExpression(headCond) ||
    headCond.operatorToken.kind !== ts.SyntaxKind.BarBarToken ||
    !keyStringCompare(headCond.left, key, ts.SyntaxKind.EqualsEqualsEqualsToken, "default") ||
    !keyStringCompare(headCond.right, key, ts.SyntaxKind.EqualsEqualsEqualsToken, "__esModule")
  ) {
    return null;
  }
  let i = 1;
  if (i < stmts.length - 1) {
    const s = stmts[i]!;
    if (ts.isIfStatement(s) && s.elseStatement === undefined && isBareReturn(s.thenStatement) && isHasOwnCall(s.expression, key)) i++;
  }
  if (i < stmts.length - 1) {
    // `if (KEY in EXPORTS && EXPORTS[KEY] === ID1[KEY]) return;`
    const s = stmts[i]!;
    if (ts.isIfStatement(s) && s.elseStatement === undefined && isBareReturn(s.thenStatement)) {
      const c = s.expression;
      const inOk =
        ts.isBinaryExpression(c) &&
        c.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        ts.isBinaryExpression(c.left) &&
        c.left.operatorToken.kind === ts.SyntaxKind.InKeyword &&
        ts.isIdentifier(c.left.left) &&
        c.left.left.text === key &&
        isExportsTarget(c.left.right) &&
        ts.isBinaryExpression(c.right) &&
        c.right.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        isKeyedAccess(c.right.left, isExportsTarget, key) &&
        isKeyedAccess(c.right.right, (x) => ts.isIdentifier(x) && x.text === id1, key);
      if (inOk) i++;
    }
  }
  if (i !== stmts.length - 1) return null;
  return isCopyStatement(stmts[i]!, id1, key) ? id1 : null;
}

/* ── the walk ──────────────────────────────────────────────────────────── */

/** Node kinds whose CHILDREN sit behind a `{` (or `${`) — merve's
 * "top-level" for the star patterns is brace depth 0, so an unbraced
 * `if (c) __exportStar(...)` still counts while any block hides it. */
function opensBraces(n: ts.Node): boolean {
  switch (n.kind) {
    case ts.SyntaxKind.Block:
    case ts.SyntaxKind.ModuleBlock:
    case ts.SyntaxKind.CaseBlock:
    case ts.SyntaxKind.ObjectLiteralExpression:
    case ts.SyntaxKind.ObjectBindingPattern:
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.ClassExpression:
    case ts.SyntaxKind.EnumDeclaration:
    case ts.SyntaxKind.TemplateSpan:
      return true;
    default:
      return false;
  }
}

/** Preorder walk with an EXPLICIT stack (minified npm bundles nest deeply
 * enough to overflow recursive visits) carrying each node's brace depth. */
function walkWithBraceDepth(sf: ts.SourceFile, cb: (node: ts.Node, braceDepth: number) => void): void {
  const stack: [ts.Node, number][] = [[sf, 0]];
  const children: ts.Node[] = [];
  while (stack.length > 0) {
    const [n, depth] = stack.pop()!;
    cb(n, depth);
    const childDepth = depth + (opensBraces(n) ? 1 : 0);
    children.length = 0;
    ts.forEachChild(n, (c) => {
      children.push(c);
    });
    for (let i = children.length - 1; i >= 0; i--) stack.push([children[i]!, childDepth]);
  }
}

/** The single-file lex over SOURCE TEXT: every detection site, position-
 * blind like the real lexer for the assignment forms (nested functions and
 * dead branches count), brace-depth-0 for the star patterns. */
export function cjsLexedExportsOf(source: string, fileName = "module.cjs"): CjsLexedExports {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const exports = new Set<string>();
  /** Position-ordered reexport EVENTS: every `module.exports =` assignment
   * clears the pending list before contributing its own require forms;
   * star calls and Babel loops append at their own positions (a loop's
   * position is the LOOP's, not its var's — probed). */
  type ReexportEvent =
    | { pos: number; kind: "assign"; rhs: ts.Expression }
    | { pos: number; kind: "spec"; spec: string }
    | { pos: number; kind: "loop"; id1: string };
  const events: ReexportEvent[] = [];
  /** Star-assignment declarators by identifier — the Babel loop's linkage. */
  const starAssigns = new Map<string, string[]>();
  walkWithBraceDepth(sf, (n, braceDepth) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const lhs = n.left;
      if (
        ts.isPropertyAccessExpression(lhs) &&
        lhs.questionDotToken === undefined &&
        ts.isIdentifier(lhs.name) &&
        (isExportsIdent(lhs.expression) || isModuleExports(lhs.expression)) &&
        // the whole NAME must be one identifier run — a unicode escape
        // mid-name breaks merve's run before the `=`, so the pattern
        // never matches (probed: Node detects nothing)
        isIdentTokenNode(lhs.name, sf)
      ) {
        exports.add(lhs.name.text);
      } else if (
        ts.isElementAccessExpression(lhs) &&
        lhs.questionDotToken === undefined &&
        ts.isStringLiteral(lhs.argumentExpression) &&
        (isExportsIdent(lhs.expression) || isModuleExports(lhs.expression))
      ) {
        exports.add(lhs.argumentExpression.text);
      } else if (isModuleExports(lhs)) {
        events.push({ pos: n.getStart(sf), kind: "assign", rhs: n.right });
      }
    } else if (ts.isCallExpression(n)) {
      scanDefineProperty(n, sf, exports);
      if (braceDepth === 0) {
        const starSpec = starExportSpecOf(n, sf);
        if (starSpec !== null) events.push({ pos: n.getStart(sf), kind: "spec", spec: starSpec });
        const loopId = starLoopIdOf(n, sf);
        if (loopId !== null) events.push({ pos: n.getStart(sf), kind: "loop", id1: loopId });
      }
    } else if (ts.isVariableStatement(n) && braceDepth === 0) {
      const assign = starAssignOf(n, sf);
      if (assign !== null) {
        const specs = starAssigns.get(assign[0]);
        if (specs === undefined) starAssigns.set(assign[0], [assign[1]]);
        else specs.push(assign[1]);
      }
    }
  });
  events.sort((a, b) => a.pos - b.pos);
  let reexports: string[] = [];
  for (const ev of events) {
    if (ev.kind === "spec") {
      reexports.push(ev.spec);
    } else if (ev.kind === "loop") {
      for (const spec of starAssigns.get(ev.id1) ?? []) reexports.push(spec);
    } else {
      reexports = []; // every `module.exports =` clears — stars included (probed)
      const req = leadingRequireOf(ev.rhs, sf);
      if (req !== null) {
        reexports.push(req.spec);
      } else if (ts.isObjectLiteralExpression(ev.rhs)) {
        // A PARENTHESIZED literal never matches — merve needs the `{` right
        // after the `=` — so no unwrapping here (unlike the checker's view).
        scanTableLiteral(ev.rhs, sf, exports, reexports);
      }
    }
  }
  return { exports, reexports };
}

/** The full Node-visible named-export set of a CommonJS module: its own
 * lexed names plus, recursively, the names of every reexport target that
 * itself resolves to a CommonJS module (Node's cjsPreparseModuleExports —
 * ESM / JSON / builtin / unresolved targets contribute nothing). Generic
 * over the caller's module HANDLE so both typescript worlds can drive it
 * with their own file objects — only strings cross this boundary.
 * Cycle-safe. */
export function cjsLexerVisibleNames<H>(
  mod: H,
  sourceOf: (mod: H) => string,
  resolveCjsDep: (from: H, spec: string) => H | null,
  memo: Map<H, Set<string>> = new Map(),
): Set<string> {
  const hit = memo.get(mod);
  if (hit !== undefined) return hit;
  const { exports, reexports } = cjsLexedExportsOf(sourceOf(mod));
  memo.set(mod, exports); // set BEFORE recursing, like Node — cycles converge
  for (const spec of reexports) {
    const dep = resolveCjsDep(mod, spec);
    if (dep === null) continue;
    for (const name of cjsLexerVisibleNames(dep, sourceOf, resolveCjsDep, memo)) exports.add(name);
  }
  return exports;
}
