import * as ts from "./ts7/adapter.js";
import { npmStaticPackageOfPath } from "./npm-static.js";
import { isJsSourceFileName } from "./tsc-codes.js";

/** Splits the bindings minified `--npm-static` JavaScript reuses for
 * unrelated values (`request = request.aborted ? request.fatalError : x`,
 * `resumableState = new RequestInstance(...)`) into one binding per web: the
 * writes that reach a common read belong to one web, found by a
 * reaching-definitions pass over each function. A web the function's entry
 * value does not reach is renamed to a fresh `var`, declared where the body
 * opens, so each binding holds one kind of value and the lowering can type
 * it instead of treating the reused binding as checked-dynamic.
 *
 * The pass is conservative where JavaScript control flow is implicit: a
 * catch block starts from every value its try block can have written, and
 * a binding written in a finally block, referenced by a nested function (a
 * closure runs at any time), used in shorthand or destructuring, or written
 * by a for-in/of head, or written inside an optional chain (whose rest may
 * not run) stays whole. Files that use `eval` or `with` are left
 * alone, as are functions of sloppy files that read `arguments` (which
 * aliases the parameters). The texts are keyed by file; each edit stays on
 * its line. */
export function npmStaticBindingSplits(program: ts.Program): Map<string, string> {
  const texts = new Map<string, string>();
  const checker = program.getTypeChecker();
  for (const sf of program.getSourceFiles()) {
    if (!isJsSourceFileName(sf.fileName) || npmStaticPackageOfPath(sf.fileName) === null) continue;
    const text = splitFile(checker, sf);
    if (text !== null) texts.set(sf.fileName, text);
  }
  return texts;
}

interface Edit {
  at: number;
  remove: number;
  text: string;
}

/** A binding being analyzed: its writes by id (0 is the value it has when
 * the function starts) and each read's reaching writes. */
interface Binding {
  name: string;
  /** A parameter keeps its name for the entry value: one its function
   * writes is not typed by its callers' arguments. */
  parameter: boolean;
  /** Written names, by write id; index 0 (the entry value) has none. */
  writes: (ts.Identifier | null)[];
  writeIds: Map<ts.Node, number>;
  reads: Map<ts.Identifier, Set<number>>;
  whole: boolean;
}

type State = Map<Binding, Set<number>> | null;

interface Target {
  label: string | null;
  loop: boolean;
  breakable: boolean;
  breaks: State[];
  continues: State[];
}

function splitFile(checker: ts.TypeChecker, sf: ts.SourceFile): string | null {
  if (/\beval\s*\(|\bwith\s*\(/.test(sf.text)) return null;
  const strict = /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*["']use strict["']/.test(sf.text);
  let edits: Edit[] = [];
  const used = new Set<string>();
  const freshName = (base: string): string => {
    for (let n = 1; ; n++) {
      const name = `${base}$${n}`;
      if (used.has(name)) continue;
      if (new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(sf.text)) continue;
      used.add(name);
      return name;
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      const body = (node as { body?: ts.Node }).body;
      if (
        body &&
        ts.isBlock(body) &&
        (strict || !/\barguments\b/.test(sf.text.slice(body.pos, body.end)))
      )
        splitFunction(checker, node, body, freshName, edits);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (edits.length === 0) return null;
  let text = sf.text;
  // An increment both reads and writes its name: one edit per position.
  const seen = new Set<number>();
  edits = edits.filter((edit) => !seen.has(edit.at) && seen.add(edit.at));
  for (const edit of edits.sort((a, b) => b.at - a.at))
    text = text.slice(0, edit.at) + edit.text + text.slice(edit.at + edit.remove);
  return text;
}

function splitFunction(
  checker: ts.TypeChecker,
  fn: ts.SignatureDeclaration,
  body: ts.Block,
  freshName: (base: string) => string,
  edits: Edit[],
): void {
  // The parameters and `var` bindings of exactly this function.
  const bindings = new Map<ts.Symbol, Binding>();
  const byName = new Map<string, ts.Symbol[]>();
  const register = (name: ts.Identifier): void => {
    const symbol = checker.getSymbolAtLocation(name);
    if (!symbol || bindings.has(symbol)) return;
    const declarations = symbol.declarations ?? [];
    if (
      !declarations.every(
        (d) =>
          ts.isParameter(d) ||
          (ts.isVariableDeclaration(d) && !(d.parent!.flags & ts.NodeFlags.BlockScoped)),
      )
    )
      return;
    bindings.set(symbol, {
      name: name.text,
      parameter: ts.isParameter(name.parent),
      writes: [null],
      writeIds: new Map(),
      reads: new Map(),
      whole: false,
    });
    const list = byName.get(name.text);
    if (list) list.push(symbol);
    else byName.set(name.text, [symbol]);
  };
  for (const param of fn.parameters.nodes) if (ts.isIdentifier(param.name)) register(param.name);
  const declare = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || isClassLike(node)) return;
    if (
      ts.isVariableDeclarationList(node) &&
      !(node.flags & ts.NodeFlags.BlockScoped) &&
      !ts.isForInStatement(node.parent) &&
      !ts.isForOfStatement(node.parent)
    )
      for (const decl of node.declarations.nodes)
        if (ts.isIdentifier(decl.name)) register(decl.name);
    ts.forEachChild(node, declare);
  };
  declare(body);
  if (bindings.size === 0) return;
  const symbolOf = new Map([...bindings].map(([symbol, binding]) => [binding, symbol]));
  const bindingOf = (id: ts.Identifier): Binding | undefined => {
    const candidates = byName.get(id.text);
    if (!candidates) return undefined;
    const symbol = checker.getSymbolAtLocation(id);
    return symbol ? bindings.get(symbol) : undefined;
  };
  // Bindings a nested function or class references, or that appear in
  // shorthand, destructuring or a for-in/of head, stay whole.
  const scan = (node: ts.Node, nested: boolean): void => {
    if (ts.isIdentifier(node)) {
      const binding = bindingOf(node);
      if (!binding) return;
      const parent = node.parent;
      if (
        nested ||
        ts.isShorthandPropertyAssignment(parent) ||
        ts.isBindingElement(parent) ||
        isPatternTarget(node) ||
        (writesIn(node) && inOptionalChain(node))
      )
        binding.whole = true;
      return;
    }
    ts.forEachChild(node, (child) =>
      scan(child, nested || ts.isFunctionLike(child) || isClassLike(child)),
    );
  };
  scan(body, false);
  const live = [...bindings.values()].filter((b) => !b.whole);
  if (live.length === 0) return;

  // Reaching definitions, structured over the AST in evaluation order.
  const clone = (s: State): State =>
    s === null ? null : new Map([...s].map(([b, defs]) => [b, new Set(defs)]));
  const merge = (a: State, b: State): State => {
    if (a === null) return clone(b);
    if (b === null) return clone(a);
    const out = clone(a)!;
    for (const [binding, defs] of b) for (const d of defs) out.get(binding)!.add(d);
    return out;
  };
  const same = (a: State, b: State): boolean => {
    if (a === null || b === null) return a === b;
    for (const [binding, defs] of a) {
      const other = b.get(binding)!;
      if (other.size !== defs.size) return false;
      for (const d of defs) if (!other.has(d)) return false;
    }
    return true;
  };
  const writeId = (binding: Binding, node: ts.Identifier): number => {
    let id = binding.writeIds.get(node);
    if (id === undefined) {
      id = binding.writes.length;
      binding.writes.push(node);
      binding.writeIds.set(node, id);
    }
    return id;
  };
  // Writes seen inside the try blocks being analyzed.
  const tryWrites: Map<Binding, Set<number>>[] = [];
  const write = (s: State, id: ts.Identifier): State => {
    const binding = bindingOf(id);
    if (!binding || binding.whole || s === null) return s;
    const w = writeId(binding, id);
    s.set(binding, new Set([w]));
    for (const seen of tryWrites) {
      const set = seen.get(binding);
      if (set) set.add(w);
      else seen.set(binding, new Set([w]));
    }
    return s;
  };
  const read = (s: State, id: ts.Identifier): void => {
    const binding = bindingOf(id);
    if (!binding || binding.whole || s === null) return;
    const set = binding.reads.get(id);
    const defs = s.get(binding)!;
    if (set) for (const d of defs) set.add(d);
    else binding.reads.set(id, new Set(defs));
  };
  const targets: Target[] = [];

  const expr = (node: ts.Node, s: State): State => {
    if (s === null || ts.isFunctionLike(node) || isClassLike(node)) return s;
    if (ts.isIdentifier(node)) {
      read(s, node);
      return s;
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const left = node.left;
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      ) {
        const after = expr(left, s);
        return merge(after, expr(node.right, clone(after)));
      }
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) {
        if (ts.isIdentifier(left)) {
          if (op === ts.SyntaxKind.EqualsToken) return write(expr(node.right, s), left);
          read(s, left);
          if (
            op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
            op === ts.SyntaxKind.BarBarEqualsToken ||
            op === ts.SyntaxKind.QuestionQuestionEqualsToken
          ) {
            const skipped = clone(s);
            return merge(skipped, write(expr(node.right, s), left));
          }
          return write(expr(node.right, s), left);
        }
        return expr(node.right, expr(left, s));
      }
      return expr(node.right, expr(left, s));
    }
    if (ts.isConditionalExpression(node)) {
      const after = expr(node.condition, s);
      return merge(expr(node.whenTrue, clone(after)), expr(node.whenFalse, clone(after)));
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand)
    ) {
      read(s, node.operand);
      return write(s, node.operand);
    }
    let out: State = s;
    ts.forEachChild(node, (child) => {
      out = expr(child, out);
    });
    return out;
  };

  const loop = (
    label: string | null,
    s: State,
    run: (head: State) => { next: State; exit: State },
  ): State => {
    let head = clone(s);
    for (;;) {
      const target: Target = { label, loop: true, breakable: true, breaks: [], continues: [] };
      targets.push(target);
      const { next, exit } = run(clone(head));
      targets.pop();
      const back = target.continues.reduce<State>((acc, c) => merge(acc, c), next);
      const widened = merge(head, back);
      if (same(widened, head)) return target.breaks.reduce<State>((acc, b) => merge(acc, b), exit);
      head = widened;
    }
  };

  const stmt = (node: ts.Node, s: State, label: string | null = null): State => {
    if (s === null) return null;
    if (ts.isBlock(node)) {
      for (const child of node.statements.nodes) s = stmt(child, s);
      return s;
    }
    if (ts.isVariableStatement(node)) return declarations(node.declarationList, s);
    if (ts.isExpressionStatement(node)) return expr(node.expression, s);
    if (ts.isIfStatement(node)) {
      const after = expr(node.expression, s);
      const then = stmt(node.thenStatement, clone(after));
      return merge(then, node.elseStatement ? stmt(node.elseStatement, clone(after)) : after);
    }
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
      if (node.expression) expr(node.expression, s);
      return null;
    }
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      const name = node.label?.text ?? null;
      const isBreak = ts.isBreakStatement(node);
      for (let i = targets.length - 1; i >= 0; i--) {
        const target = targets[i]!;
        const matches =
          name === null ? (isBreak ? target.breakable : target.loop) : target.label === name;
        if (!matches) continue;
        (isBreak ? target.breaks : target.continues).push(clone(s));
        return null;
      }
      return null;
    }
    if (ts.isLabeledStatement(node)) {
      const inner = node.statement;
      if (isLoop(inner)) return stmt(inner, s, node.label.text);
      const target: Target = {
        label: node.label.text,
        loop: false,
        breakable: false,
        breaks: [],
        continues: [],
      };
      targets.push(target);
      const end = stmt(inner, s);
      targets.pop();
      return target.breaks.reduce<State>((acc, b) => merge(acc, b), end);
    }
    if (ts.isWhileStatement(node))
      return loop(label, s, (head) => {
        const tested = expr(node.expression, head);
        return { next: stmt(node.statement, clone(tested)), exit: tested };
      });
    if (ts.isDoStatement(node))
      return loop(label, s, (head) => {
        const end = stmt(node.statement, head);
        const target = targets.at(-1)!;
        const tested = expr(
          node.expression,
          target.continues.reduce<State>((acc, c) => merge(acc, c), end),
        );
        target.continues.length = 0;
        return { next: tested, exit: clone(tested) };
      });
    if (ts.isForStatement(node)) {
      if (node.initializer)
        s = ts.isVariableDeclarationList(node.initializer)
          ? declarations(node.initializer, s)
          : expr(node.initializer, s);
      return loop(label, s, (head) => {
        const tested = node.condition ? expr(node.condition, head) : head;
        const end = stmt(node.statement, clone(tested));
        const target = targets.at(-1)!;
        const continued = target.continues.reduce<State>((acc, c) => merge(acc, c), end);
        target.continues.length = 0;
        return {
          next: node.incrementor ? expr(node.incrementor, continued) : continued,
          exit: node.condition ? tested : null,
        };
      });
    }
    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      s = expr(node.expression, s);
      return loop(label, s, (head) => ({ next: stmt(node.statement, clone(head)), exit: head }));
    }
    if (ts.isSwitchStatement(node)) {
      let tested = expr(node.expression, s);
      const target: Target = { label, loop: false, breakable: true, breaks: [], continues: [] };
      targets.push(target);
      let fallthrough: State = null;
      let hasDefault = false;
      for (const clause of node.caseBlock.clauses.nodes) {
        if (ts.isCaseClause(clause)) tested = expr(clause.expression, tested);
        else hasDefault = true;
        let entry = merge(clone(tested), fallthrough);
        for (const child of clause.statements.nodes) entry = stmt(child, entry);
        fallthrough = entry;
      }
      targets.pop();
      const end = merge(fallthrough, hasDefault ? null : tested);
      return target.breaks.reduce<State>((acc, b) => merge(acc, b), end);
    }
    if (ts.isTryStatement(node)) {
      const seen = new Map<Binding, Set<number>>();
      tryWrites.push(seen);
      const tried = stmt(node.tryBlock, clone(s));
      tryWrites.pop();
      // The catch block starts from any value the try block can leave.
      const entry = clone(s)!;
      for (const [binding, defs] of seen) for (const d of defs) entry.get(binding)!.add(d);
      let caught: State = null;
      if (node.catchClause) {
        const catchSeen = new Map<Binding, Set<number>>();
        tryWrites.push(catchSeen);
        caught = stmt(node.catchClause.block, clone(entry));
        tryWrites.pop();
        for (const [binding, defs] of catchSeen) for (const d of defs) entry.get(binding)!.add(d);
      }
      if (!node.finallyBlock) return merge(tried, caught);
      markWritten(node.finallyBlock, bindingOf);
      const finished = stmt(node.finallyBlock, merge(merge(tried, caught), entry));
      return tried === null && caught === null ? null : finished;
    }
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEmptyStatement(node))
      return s;
    // Any other statement: every binding it mentions stays whole.
    markAll(node, bindingOf);
    return s;
  };

  const declarations = (list: ts.VariableDeclarationList, s: State): State => {
    for (const decl of list.declarations.nodes) {
      if (decl.initializer) s = expr(decl.initializer, s);
      if (!ts.isIdentifier(decl.name)) {
        markAll(decl.name, bindingOf);
        continue;
      }
      // `var x;` keeps the value.
      if (decl.initializer) s = write(s, decl.name);
    }
    return s;
  };

  const entry: State = new Map(live.map((b) => [b, new Set([0])]));
  for (const b of bindings.values()) if (b.whole) entry!.set(b, new Set([0]));
  stmt(body, entry);

  // Webs: the writes a read can see belong together.
  const declared: string[] = [];
  for (const binding of live) {
    if (binding.whole) continue;
    const parent = binding.writes.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    for (const defs of binding.reads.values()) {
      const [first, ...rest] = defs;
      if (first === undefined) continue;
      for (const d of rest) parent[find(d)] = find(first);
    }
    // `x op= v` and `x++` read and write one name: the value written joins
    // the web of the value read.
    for (const [id, w] of binding.writeIds) {
      const [first] = binding.reads.get(id as ts.Identifier) ?? [];
      if (first !== undefined) parent[find(w)] = find(first);
    }
    const readWebs = new Set<number>();
    for (const defs of binding.reads.values()) {
      const [first] = defs;
      if (first !== undefined) readWebs.add(find(first));
    }
    // The binding keeps its name for the entry value's web, or, for a
    // variable no read sees the entry value of, for the first web read.
    let entryWeb = find(0);
    if (!binding.parameter && !readWebs.has(entryWeb)) {
      for (let i = 1; i < binding.writes.length; i++) {
        if (!readWebs.has(find(i))) continue;
        entryWeb = find(i);
        break;
      }
    }
    if (readWebs.size === 0 || (readWebs.size === 1 && readWebs.has(entryWeb))) continue;
    // A split pays when it separates values of different types (`target`
    // holding a view, then an encodeInto result): each web then has one
    // type the lowering can hold natively. Webs of one type, or of values
    // the checker cannot type, stay one binding.
    if (binding.parameter) continue;
    const webTypes = new Map<number, Set<string>>();
    for (let i = 1; i < binding.writes.length; i++) {
      const web = find(i);
      if (!readWebs.has(web)) continue;
      let set = webTypes.get(web);
      if (!set) webTypes.set(web, (set = new Set()));
      set.add(writtenTypeText(checker, binding.writes[i]!));
    }
    const typed = [...webTypes.values()].filter((set) => !set.has("any"));
    const kinds = new Set([...webTypes.values()].map((set) => [...set].sort().join("|")));
    if (typed.length === 0 || kinds.size < 2) continue;
    const names = new Map<number, string>();
    const nameOf = (web: number): string => {
      let name = names.get(web);
      if (!name) {
        name = freshName(binding.name);
        names.set(web, name);
      }
      return name;
    };
    for (const [id, defs] of binding.reads) {
      const [first] = defs;
      if (first === undefined) continue;
      const web = find(first);
      if (web === entryWeb) continue;
      edits.push({ at: ts.tokenStartOfNode(id), remove: id.text.length, text: nameOf(web) });
    }
    // A fresh binding is declared at its first write when that write is
    // an assignment statement (or already a declaration): a declaration
    // without a value would add `undefined` to what the binding holds.
    const declaredWebs = new Set<number>();
    const renamed = new Set<ts.Identifier>();
    for (let i = 1; i < binding.writes.length; i++) {
      const web = find(i);
      if (web === entryWeb || !readWebs.has(web)) continue;
      const id = binding.writes[i]!;
      renamed.add(id);
      const parent = id.parent;
      let text = nameOf(web);
      if (ts.isVariableDeclaration(parent)) declaredWebs.add(web);
      else if (
        !declaredWebs.has(web) &&
        ts.isBinaryExpression(parent) &&
        ts.isExpressionStatement(parent.parent)
      ) {
        declaredWebs.add(web);
        text = `var ${text}`;
      }
      edits.push({ at: ts.tokenStartOfNode(id), remove: id.text.length, text });
    }
    for (const [web, name] of names) if (!declaredWebs.has(web)) declared.push(name);
    // Renaming can take all of a variable's declarations; the reads left on
    // its name still need one (a `var` redeclaration keeps the value).
    const keepsDeclaration = (symbolOf.get(binding)?.declarations ?? []).some(
      (decl) =>
        ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && !renamed.has(decl.name),
    );
    if (!binding.parameter && names.size > 0 && !keepsDeclaration) declared.push(binding.name);
  }
  if (declared.length > 0)
    edits.push({
      at: ts.tokenStartOfNode(body) + 1,
      remove: 0,
      text: ` var ${declared.join(", ")};`,
    });
}

function isLoop(node: ts.Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

/** Whether an identifier is a destructuring target or a for-in/of head. */
function isPatternTarget(id: ts.Identifier): boolean {
  let node: ts.Node = id;
  let nested = false;
  for (;;) {
    const parent = node.parent;
    if (!parent) return false;
    if (
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === node)
    ) {
      nested = true;
      node = parent;
      continue;
    }
    if (ts.isParenthesizedExpression(parent)) {
      node = parent;
      continue;
    }
    if (ts.isBinaryExpression(parent))
      return (
        nested && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      );
    if (ts.isForInStatement(parent) || ts.isForOfStatement(parent))
      return parent.initializer === node;
    return false;
  }
}

function markAll(node: ts.Node, bindingOf: (id: ts.Identifier) => Binding | undefined): void {
  if (ts.isIdentifier(node)) {
    const binding = bindingOf(node);
    if (binding) binding.whole = true;
    return;
  }
  ts.forEachChild(node, (child) => markAll(child, bindingOf));
}

/** A finally block runs on every exit, which the analysis does not track:
 * bindings it writes stay whole. */
function markWritten(node: ts.Node, bindingOf: (id: ts.Identifier) => Binding | undefined): void {
  if (ts.isIdentifier(node)) {
    const parent = node.parent;
    if (writesIn(node) || (ts.isVariableDeclaration(parent) && parent.name === node)) {
      const binding = bindingOf(node);
      if (binding) binding.whole = true;
    }
    return;
  }
  ts.forEachChild(node, (child) => markWritten(child, bindingOf));
}

/** Whether an identifier is the target of an assignment or increment. */
function writesIn(id: ts.Identifier): boolean {
  const parent = id.parent;
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === id &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
    ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken))
  );
}

function inOptionalChain(node: ts.Node): boolean {
  for (let up = node.parent; up && !ts.isStatement(up) && !ts.isFunctionLike(up); up = up.parent)
    if (up.flags & ts.NodeFlags.OptionalChain) return true;
  return false;
}

function isClassLike(node: ts.Node): boolean {
  return ts.isClassDeclaration(node) || ts.isClassExpression(node);
}

/** The checker's widened type of the value a write stores, as text: `any`
 * when the checker cannot type it. */
function writtenTypeText(checker: ts.TypeChecker, id: ts.Identifier): string {
  const parent = id.parent;
  const value =
    ts.isVariableDeclaration(parent) && parent.name === id
      ? parent.initializer
      : ts.isBinaryExpression(parent) && parent.left === id
        ? parent.right
        : undefined;
  if (!value) return "any";
  const type = checker.getTypeAtLocation(value);
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return "any";
  return checker.typeToString(checker.getBaseTypeOfLiteralType(type));
}
