/* Shared modules between the program and its Node islands (scope-B NI-6,
 * DESIGN.md §2.6). A module the program compiles that island code also
 * imports would otherwise exist twice, with two states. Rule: each module
 * has exactly one owner.
 *
 *  - Program modules (user code): always shared, owned by the program.
 *  - npm packages compiled natively and imported by island code: shared
 *    when stateful (module-level state written after evaluation, exported
 *    classes, evaluation effects), duplicated when pure (each side has its
 *    own copy, which nobody can observe). `scriptc.packages.<name>.share`
 *    ("shared" | "duplicate") overrides; duplicating a stateful package is
 *    SC8020, a warning, because the two copies diverge.
 *
 * A shared module is registered at program start (nodeIsland.share, never
 * loads Node) with its accessor: a generated function that answers the
 * current values of its exports as a dyn array, the TDZ sentinel for a let
 * or const whose declaration has not run yet (a flag the module's %init
 * sets right after the declaration). The bootstrap's loader hooks
 * (runtime scr_node_island_hooks.cjs) resolve island imports of the module
 * to a generated ES module over those values.
 *
 * Island code is found syntactically: the files requireModule() loads and
 * every JavaScript file of an island package, then the files they import
 * that the program does not compile (Node's side of the closure). An
 * import that resolves to a compiled module makes it a candidate. A
 * specifier inside a comment or string can only add a candidate (an extra
 * shared module), never lose one. */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolveFrom } from "../../node-islands/resolve.js";
import { join } from "node:path";
import * as ts from "../ts7/adapter.js";
import { locOf, isCjsJsFile } from "../program.js";
import { PoisonError, newFnCtx, type Lowerer } from "./lowerer.js";
import { BOOL, DYN, STRING, VOID, type IrExpr, type IrStmt, type SrcLoc } from "../../ir/ir.js";
import { resolveBareModule } from "../resolve.js";
import { packageDirOf } from "../../node-islands/origin.js";
import { requireModuleSpecifiers, scanModuleSpecifiers } from "../../node-islands/modules.js";
import { readProjectConfig } from "../../project-config.js";
import {
  sharedClassExtendedDiag,
  sharedModuleDuplicatedDiag,
} from "../../diagnostics/diagnostic.js";
import {
  classConstructHelper,
  classMethodsBuilder,
  islandSharedPath,
} from "./lower-node-island.js";
import { dynUndefinedExpr } from "../../ir/build.js";
import { funcTypeFromParamShapes } from "./call-signatures.js";
import { stripTypeWrappers } from "./typed-arguments.js";

type ExportKind = "function" | "class" | "let" | "const" | "var";

interface SharedExport {
  name: string;
  kind: ExportKind;
  /** The declaration's name: its reference is the export's value. */
  ident: ts.Identifier;
  /** let/const: the flag global set after the declaration ran. */
  flag?: string;
}

export interface SharedModulePlan {
  sf: ts.SourceFile;
  /** The real path Node resolves the module to. */
  path: string;
  exports: SharedExport[];
}

const MAX_ISLAND_FILES = 4000;

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isJsFile(path: string): boolean {
  return /\.(?:[cm]?js)$/.test(path);
}

/** The files `spec` may name from `from` (require and import conditions). */
function resolveAll(from: string, spec: string): string[] {
  if (spec.startsWith("node:")) return [];
  const out = new Set<string>();
  try {
    out.add(real(resolveFrom(from, spec)));
  } catch {
    /* not resolvable for require */
  }
  if (!spec.startsWith(".") && !spec.startsWith("/")) {
    for (const kind of ["import", "require"] as const) {
      const js = resolveBareModule(from, spec, "js-only", kind);
      if (js !== null) out.add(real(js.typesFile));
    }
  }
  return [...out];
}

function packageJsFiles(dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (out.length >= MAX_ISLAND_FILES) return;
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) packageJsFiles(path, out);
    else if (isJsFile(name)) out.push(real(path));
  }
}

function isExported(stmt: ts.Node): boolean {
  const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function isDefaultExport(stmt: ts.Node): boolean {
  const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
  return mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) === true;
}

/** The top-level declarations of a module by name. */
function localDeclarations(
  sf: ts.SourceFile,
): Map<string, { kind: ExportKind; ident: ts.Identifier }> {
  const out = new Map<string, { kind: ExportKind; ident: ts.Identifier }>();
  for (const stmt of sf.statements.nodes) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body)
      out.set(stmt.name.text, { kind: "function", ident: stmt.name });
    else if (ts.isClassDeclaration(stmt) && stmt.name)
      out.set(stmt.name.text, { kind: "class", ident: stmt.name });
    else if (ts.isVariableStatement(stmt)) {
      const flags = stmt.declarationList.flags;
      const kind: ExportKind =
        (flags & ts.NodeFlags.Const) !== 0
          ? "const"
          : (flags & ts.NodeFlags.Let) !== 0
            ? "let"
            : "var";
      for (const d of stmt.declarationList.declarations.nodes)
        if (ts.isIdentifier(d.name)) out.set(d.name.text, { kind, ident: d.name });
    }
  }
  return out;
}

/** The module's value exports (re-exports and default exports of
 * expressions are not shared: NOTES.md shortcut). */
function moduleExports(sf: ts.SourceFile): SharedExport[] {
  const locals = localDeclarations(sf);
  const out: SharedExport[] = [];
  for (const stmt of sf.statements.nodes) {
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.moduleSpecifier || stmt.isTypeOnly || !stmt.exportClause) continue;
      if (!ts.isNamedExports(stmt.exportClause)) continue;
      for (const el of stmt.exportClause.elements.nodes) {
        if (el.isTypeOnly) continue;
        const local = locals.get((el.propertyName ?? el.name).text);
        if (local !== undefined) out.push({ name: el.name.text, ...local });
      }
      continue;
    }
    if (!isExported(stmt)) continue;
    const def = isDefaultExport(stmt);
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body)
      out.push({ name: def ? "default" : stmt.name.text, kind: "function", ident: stmt.name });
    else if (ts.isClassDeclaration(stmt) && stmt.name)
      out.push({ name: def ? "default" : stmt.name.text, kind: "class", ident: stmt.name });
    else if (ts.isVariableStatement(stmt)) {
      const flags = stmt.declarationList.flags;
      const kind: ExportKind =
        (flags & ts.NodeFlags.Const) !== 0
          ? "const"
          : (flags & ts.NodeFlags.Let) !== 0
            ? "let"
            : "var";
      for (const d of stmt.declarationList.declarations.nodes)
        if (ts.isIdentifier(d.name)) out.push({ name: d.name.text, kind, ident: d.name });
    }
  }
  return out;
}

/** The name of a class imported from `spec` that the island file extends
 * (`class X extends Base` or `extends ns.Base`), or null. */
function extendedImport(text: string, spec: string): string | null {
  const quoted = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names: string[] = [];
  const named = new RegExp(
    `import\\s*(?:(\\w+)\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*["']${quoted}["']`,
    "g",
  );
  for (const m of text.matchAll(named)) {
    if (m[1] !== undefined) names.push(m[1]);
    for (const part of m[2]!.split(",")) {
      const local = part
        .trim()
        .split(/\s+as\s+/)
        .at(-1)
        ?.trim();
      if (local) names.push(local);
    }
  }
  const star = new RegExp(`import\\s*\\*\\s*as\\s+(\\w+)\\s*from\\s*["']${quoted}["']`, "g");
  for (const m of text.matchAll(star)) names.push(`${m[1]!}\\.\\w+`);
  const def = new RegExp(`import\\s+(\\w+)\\s+from\\s*["']${quoted}["']`, "g");
  for (const m of text.matchAll(def)) names.push(m[1]!);
  for (const name of names) {
    const m = new RegExp(`\\bclass\\s+[\\w$]*\\s*extends\\s+(${name})\\b`).exec(text);
    if (m !== null) return m[1]!;
  }
  return null;
}

const MUTATING_METHODS = new Set([
  "set",
  "add",
  "delete",
  "clear",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);

/** Why a module is stateful (one reason), or null when it is pure: no
 * module-level binding reachable from its exports is written after
 * evaluation, no exported class (its instances may cross or meet
 * instanceof in island code), and no top-level effect beyond declarations. */
/** Whether evaluating a module-level initializer runs no code: literals,
 * names, functions and classes it creates, `require()` of a module (which
 * is judged on its own), and object, array and operator expressions over
 * those. */
function inertInitializer(node: ts.Expression): boolean {
  const e = stripTypeWrappers(node);
  if (
    ts.isIdentifier(e) ||
    ts.isLiteralExpression(e) ||
    ts.isNoSubstitutionTemplateLiteral(e) ||
    ts.isArrowFunction(e) ||
    ts.isFunctionExpression(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword
  )
    return true;
  if (ts.isClassExpression(e))
    return !e.members.nodes.some(
      (m) =>
        ts.isClassStaticBlockDeclaration(m) ||
        (ts.isPropertyDeclaration(m) &&
          m.initializer !== undefined &&
          !inertInitializer(m.initializer)),
    );
  if (ts.isParenthesizedExpression(e)) return inertInitializer(e.expression);
  if (ts.isPrefixUnaryExpression(e))
    return (
      e.operator !== ts.SyntaxKind.PlusPlusToken &&
      e.operator !== ts.SyntaxKind.MinusMinusToken &&
      inertInitializer(e.operand)
    );
  if (ts.isBinaryExpression(e))
    return (
      !ts.isAssignmentOperator(e.operatorToken.kind) &&
      e.operatorToken.kind !== ts.SyntaxKind.CommaToken &&
      inertInitializer(e.left) &&
      inertInitializer(e.right)
    );
  if (ts.isConditionalExpression(e))
    return (
      inertInitializer(e.condition) && inertInitializer(e.whenTrue) && inertInitializer(e.whenFalse)
    );
  if (ts.isArrayLiteralExpression(e))
    return e.elements.nodes.every((el) => !ts.isSpreadElement(el) && inertInitializer(el));
  if (ts.isObjectLiteralExpression(e))
    return e.properties.nodes.every(
      (p) =>
        ts.isShorthandPropertyAssignment(p) ||
        ts.isMethodDeclaration(p) ||
        (ts.isPropertyAssignment(p) &&
          !ts.isComputedPropertyName(p.name) &&
          inertInitializer(p.initializer)),
    );
  if (ts.isCallExpression(e))
    return (
      ts.isIdentifier(e.expression) &&
      e.expression.text === "require" &&
      e.arguments.nodes.length === 1 &&
      ts.isStringLiteralLike(e.arguments.nodes[0]!)
    );
  return false;
}

export function statefulReason(sf: ts.SourceFile): string | null {
  const moduleLevel = new Map<string, string>(); // name -> kind
  for (const stmt of sf.statements.nodes) {
    if (ts.isClassDeclaration(stmt) && isExported(stmt))
      return `it exports the class '${stmt.name?.text ?? "default"}'`;
    if (ts.isVariableStatement(stmt)) {
      const flags = stmt.declarationList.flags;
      for (const d of stmt.declarationList.declarations.nodes) {
        // A copy would run the initializer a second time.
        if (d.initializer !== undefined && !inertInitializer(d.initializer))
          return "its variable initializers run code";
        if (!ts.isIdentifier(d.name)) continue;
        if ((flags & ts.NodeFlags.Const) === 0) {
          if (isExported(stmt)) return `it exports the mutable binding '${d.name.text}'`;
          moduleLevel.set(d.name.text, "let");
        } else {
          moduleLevel.set(d.name.text, "const");
        }
      }
      continue;
    }
    if (
      ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isImportDeclaration(stmt) ||
      ts.isExportDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isExportAssignment(stmt) ||
      ts.isEmptyStatement(stmt)
    )
      continue;
    if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) continue; // directives
    // CommonJS export statements (`module.exports = f`, `exports.x = v`,
    // `module.exports.x = v`) and expandos on the module's own functions
    // (`f.sync = g`) declare the module's surface; they are not effects.
    if (ts.isExpressionStatement(stmt) && isCjsDeclaringAssignment(stmt.expression, functions(sf)))
      continue;
    return "its evaluation has effects beyond declarations";
  }
  // Writes from function bodies to module-level bindings.
  let reason: string | null = null;
  const visit = (node: ts.Node, inFunction: boolean): void => {
    if (reason !== null) return;
    const fn = ts.isFunctionLike(node);
    if (inFunction) {
      if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) {
        let target: ts.Node = node.left;
        while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))
          target = target.expression;
        if (ts.isIdentifier(target) && moduleLevel.has(target.text))
          reason = `its function bodies write the module-level binding '${target.text}'`;
      } else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken) &&
        ts.isIdentifier(node.operand) &&
        moduleLevel.has(node.operand.text)
      ) {
        reason = `its function bodies write the module-level binding '${node.operand.text}'`;
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        moduleLevel.has(node.expression.expression.text) &&
        MUTATING_METHODS.has(node.expression.name.text)
      ) {
        reason = `its function bodies mutate the module-level '${node.expression.expression.text}'`;
      }
    }
    ts.forEachChild(node, (child) => visit(child, inFunction || fn));
  };
  visit(sf, false);
  return reason;
}

/** The modules the program shares with its islands (computed once). */
export function sharedModulePlans(lowerer: Lowerer): SharedModulePlan[] {
  if (lowerer.sharedModules !== null) return lowerer.sharedModules;
  const plans: SharedModulePlan[] = [];
  lowerer.sharedModules = plans;
  const compiled = new Map<string, ts.SourceFile>();
  for (const sf of lowerer.moduleOrder) {
    if (sf.isDeclarationFile) continue;
    compiled.set(real(sf.fileName), sf);
  }
  // Island roots: requireModule() targets and island package files. A
  // target the program compiles itself is loaded in Node as well: shared.
  const queue: string[] = [];
  const candidates = new Set<ts.SourceFile>();
  for (const sf of lowerer.moduleOrder) {
    const text = sf.text;
    if (!text.includes("requireModule")) continue;
    const from = real(sf.fileName);
    for (const spec of requireModuleSpecifiers(text)) {
      try {
        const target = real(resolveFrom(from, spec));
        const own = compiled.get(target);
        if (own !== undefined) candidates.add(own);
        else queue.push(target);
      } catch {
        /* lowering reports it */
      }
    }
  }
  for (const island of lowerer.nodeIslands?.packages.values() ?? [])
    packageJsFiles(island.dir, queue);
  if (queue.length === 0 && candidates.size === 0) return plans;
  const seen = new Set<string>();
  // Classes island code extends, by the compiled module that exports them.
  const extended = new Map<ts.SourceFile, string>();
  while (queue.length > 0 && seen.size < MAX_ISLAND_FILES) {
    const file = queue.pop()!;
    if (seen.has(file) || compiled.has(file) || !isJsFile(file)) continue;
    seen.add(file);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Specifiers in code only: a comment or a string that looks like an
    // import names no module.
    for (const spec of scanModuleSpecifiers(text).specifiers) {
      for (const target of resolveAll(file, spec)) {
        const sf = compiled.get(target);
        if (sf !== undefined) {
          candidates.add(sf);
          const base = extendedImport(text, spec);
          if (base !== null && !extended.has(sf)) extended.set(sf, base);
        } else if (!seen.has(target)) queue.push(target);
      }
    }
  }
  if (candidates.size === 0) return plans;
  const config = readProjectConfig(lowerer.entry.fileName);
  for (const sf of lowerer.moduleOrder) {
    if (!candidates.has(sf)) continue;
    const path = real(sf.fileName);
    const pkg = packageDirOf(path);
    const loc: SrcLoc = { file: sf.fileName, start: 0, end: 0 };
    const share = pkg === null ? "shared" : (config.packages.get(pkg.name)?.share ?? "auto");
    const stateful = pkg === null ? "it is a program module" : statefulReason(sf);
    const base = extended.get(sf);
    if (base !== undefined) {
      // Island code extends one of its classes: a native instance cannot
      // take an island subclass's overrides, so the module cannot be owned
      // by the program. A package then runs in Node for both sides
      // (Node-owned, through handles; the build retries with it as an
      // island); a program module is refused.
      lowerer.pushDiag(sharedClassExtendedDiag(pkg?.name ?? null, sf.fileName, base, loc));
      continue;
    }
    if (isCjsJsFile(sf, lowerer.program)) {
      // Shortcut: CommonJS modules are not shared yet; each side keeps its
      // copy, so a stateful one is reported.
      if (stateful !== null)
        lowerer.sharedModuleWarnings.push(
          sharedModuleDuplicatedDiag(
            pkg?.name ?? sf.fileName,
            `${stateful}, and CommonJS modules cannot be shared yet`,
            loc,
          ),
        );
      continue;
    }
    if (share === "duplicate" || (share === "auto" && stateful === null)) {
      if (stateful !== null)
        lowerer.sharedModuleWarnings.push(
          sharedModuleDuplicatedDiag(
            pkg?.name ?? sf.fileName,
            `${stateful}, and it is marked "share": "duplicate"`,
            loc,
          ),
        );
      continue;
    }
    const exports = moduleExports(sf);
    for (const e of exports) {
      if (e.kind !== "let" && e.kind !== "const") continue;
      const flag = `%g.shared.${plans.length}.${e.name}%initialized`;
      lowerer.globalsList.push({ id: flag, name: "%initialized", type: BOOL, mutable: true });
      e.flag = flag;
      let stmt: ts.Node | undefined = e.ident.parent;
      while (stmt !== undefined && !ts.isVariableStatement(stmt)) stmt = stmt.parent;
      if (stmt !== undefined) {
        const list = lowerer.sharedInitFlags.get(stmt as ts.Statement) ?? [];
        list.push(flag);
        lowerer.sharedInitFlags.set(stmt as ts.Statement, list);
      }
    }
    plans.push({ sf, path, exports });
  }
  if (plans.length > 0) lowerer.usesNodeIsland = true;
  // Before island loads are lowered (the plans are computed in the first
  // module's header): the module tree ships these as placeholders.
  for (const plan of plans) lowerer.nodeIslandModules.addProvided(plan.path);
  return plans;
}

/** The flag stores after a shared module's declaration statement. */
export function sharedInitFlagStores(lowerer: Lowerer, stmt: ts.Statement): IrStmt[] {
  const flags = lowerer.sharedInitFlags.get(stmt);
  if (flags === undefined) return [];
  const loc = locOf(stmt);
  return flags.map((flag) => ({
    kind: "assign",
    localId: flag,
    value: { kind: "boolLit", value: true, type: BOOL, loc },
    loc,
  }));
}

/** The registrations the entry's %init runs first: one nodeIsland.share
 * per shared module, with its accessor. */
export function sharedModuleRegistrations(lowerer: Lowerer): IrStmt[] {
  const plans = sharedModulePlans(lowerer);
  const out: IrStmt[] = [];
  plans.forEach((plan, index) => {
    const loc: SrcLoc = { file: plan.sf.fileName, start: 0, end: 0 };
    const name = `%island.shared:${index}`;
    const ctx = newFnCtx(false, null, null, DYN);
    lowerer.fnStack.push(ctx);
    const elems: IrExpr[] = [];
    const kept: SharedExport[] = [];
    try {
      for (const e of plan.exports) {
        let value: IrExpr;
        try {
          value = lowerer.coerceToExpected(lowerer.lowerExpr(e.ident), DYN);
        } catch (error) {
          if (!(error instanceof PoisonError)) throw error;
          continue;
        }
        if (e.kind === "class") {
          const builder = classMethodsBuilder(lowerer, e.ident, loc) ?? dynUndefinedExpr(loc);
          const construct = classConstructHelper(lowerer, e.ident, loc) ?? dynUndefinedExpr(loc);
          value = {
            kind: "libCall",
            fn: "nodeIsland.classMethodsOf",
            args: [value, builder, construct],
            type: DYN,
            loc,
          };
        }
        if (e.flag !== undefined) {
          value = {
            kind: "ternary",
            cond: { kind: "varRef", localId: e.flag, type: BOOL, loc },
            then: value,
            else_: { kind: "libCall", fn: "nodeIsland.sharedTdz", args: [], type: DYN, loc },
            type: DYN,
            loc,
          };
        }
        elems.push(value);
        kept.push(e);
      }
    } finally {
      lowerer.fnStack.pop();
    }
    lowerer.liftedFns.push({
      name,
      params: [],
      returnType: DYN,
      locals: ctx.locals,
      body: [{ kind: "return", value: { kind: "dynArrLit", elems, type: DYN, loc }, loc }],
      loc,
    });
    const exportsJson = JSON.stringify(kept.map((e) => ({ name: e.name, kind: e.kind })));
    out.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "nodeIsland.share",
        args: [
          islandSharedPath(lowerer, plan.path, loc),
          { kind: "strLit", value: exportsJson, type: STRING, loc },
          lowerer.coerceToExpected(
            {
              kind: "closure",
              fnName: name,
              captures: [],
              type: funcTypeFromParamShapes([], DYN),
              loc,
            },
            DYN,
          ),
        ],
        type: VOID,
        loc,
      },
      loc,
    });
  });
  return out;
}

/** The names of a module's top-level function declarations. */
function functions(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sf.statements.nodes)
    if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined) names.add(stmt.name.text);
  return names;
}

/** `module.exports = …`, `exports.x = …`, `module.exports.x = …` (also
 * chained: `exports = module.exports = …`), or `f.x = …` for a top-level
 * function `f`. */
function isCjsDeclaringAssignment(e: ts.Expression, fns: Set<string>): boolean {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const left = e.left;
  const isModuleExports = (n: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(n) &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === "module" &&
    ts.isIdentifier(n.name) &&
    n.name.text === "exports";
  const target =
    (ts.isIdentifier(left) && left.text === "exports") ||
    isModuleExports(left) ||
    (ts.isPropertyAccessExpression(left) &&
      ((ts.isIdentifier(left.expression) &&
        (left.expression.text === "exports" || fns.has(left.expression.text))) ||
        isModuleExports(left.expression)));
  if (!target) return false;
  // A chained assignment declares too.
  const right = e.right;
  if (ts.isBinaryExpression(right) && right.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    return isCjsDeclaringAssignment(right, fns);
  return true;
}
