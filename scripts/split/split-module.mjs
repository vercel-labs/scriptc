#!/usr/bin/env node
/* Split a large TypeScript module into files by a manifest of top-level
 * declaration names, as a pure move.
 *
 *   node split-module.mjs plan  <config.json>   compute the manifest from seeds
 *   node split-module.mjs apply <config.json>   extract branches, move declarations
 *
 * <config.json>:
 *   { "tsconfig": "packages/compiler/tsconfig.json",
 *     "module": "packages/compiler/src/frontend/lowering/lower-exprs.ts",
 *     "extract": [{ "function": "lowerExprInner", "condition": "ts.isIdentifier(expr)",
 *                   "name": "lowerIdentifierExpr", "exprType": "ts.Identifier" }, ...],
 *     "seeds": { "expressions/binary.ts": ["lowerBinary", ...], ... },
 *     "manifest": "<manifest.json, relative to the config>" }
 *
 * It runs on the checkout in the current directory, or --repo <dir>, and
 * loads typescript from that checkout or --tools <dir>.
 *
 * extract turns `if (<condition>) { ...block... }` at the top level of the
 * named function into `if (<condition>) return <name>(lowerer, expr, loc);`
 * and adds `function <name>(lowerer: Lowerer, expr: <exprType>, loc: SrcLoc):
 * IrExpr { ...block... }` after it. The block must end in a call that never
 * returns, so no path falls through.
 *
 * plan assigns each seed to its file, then moves every other top-level
 * declaration whose referrers all sit in one file (other than the module)
 * into that file, to a fixpoint. Module-level `let` bindings stay put (an
 * importer cannot assign them). The manifest lists file → names.
 *
 * apply moves the manifest's declarations with their leading comments,
 * in source order, into the new files. Each new file imports what its
 * declarations reference: names from the module or another new file, and
 * the module's own imports with their paths rebased. The module imports the
 * moved names it still uses, re-exports the moved names that were exported,
 * and drops imports nothing uses anymore. Moved declarations that something
 * outside their file references get `export`. Names a manifest lists but
 * the module lacks are skipped, and new declarations stay in the module,
 * so the same manifest applies to an edited copy of the module. */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, posix } from "node:path";
import { createRequire } from "node:module";
import { confine, confineHost } from "./confine.mjs";
import { formatFiles } from "./format.mjs";

const [command, configPath, ...flags] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const flag = (name) => {
  const i = flags.indexOf(name);
  return i >= 0 ? flags[i + 1] : undefined;
};
// --repo runs on another checkout (a temporary worktree); --tools names the
// checkout whose node_modules supply typescript.
const repo = resolve(flag("--repo") ?? config.repo ?? process.cwd());
// Every read and write stays inside the checkout, or for the manifest, the
// config's directory (confine.mjs).
const checkout = confine(repo);
const configFiles = confine(dirname(resolve(configPath)));
// The manifest path is relative to the config file.
config.manifest = resolve(dirname(resolve(configPath)), flag("--manifest") ?? config.manifest);
const toolsDir = resolve(flag("--tools") ?? config.repo ?? process.cwd());
const require = createRequire(join(toolsDir, "package.json"));
const ts = require("typescript");
const modulePath = join(repo, config.module);
const moduleDir = dirname(modulePath);

function parse(text, path = modulePath) {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

/* ── extract ─────────────────────────────────────────────────────────── */

function extractBranches(text) {
  for (const spec of config.extract ?? []) {
    const sf = parse(text);
    const fn = sf.statements.find(
      (s) => ts.isFunctionDeclaration(s) && s.name?.text === spec.function,
    );
    if (!fn) throw new Error(`no function ${spec.function}`);
    const branch = fn.body.statements.find(
      (s) =>
        ts.isIfStatement(s) &&
        s.expression.getText() === spec.condition &&
        ts.isBlock(s.thenStatement) &&
        !s.elseStatement,
    );
    if (!branch) {
      console.error(`skip: no \`if (${spec.condition}) { ... }\` in ${spec.function}`);
      continue;
    }
    const block = branch.thenStatement;
    const last = block.statements.at(-1);
    if (
      !last ||
      !(ts.isExpressionStatement(last) || ts.isReturnStatement(last) || ts.isThrowStatement(last))
    )
      throw new Error(
        `${spec.condition}: the block must end in a never-returning call, return or throw`,
      );
    // The block's inner text, dedented one level (two spaces).
    const inner = text.slice(block.statements[0].getFullStart(), block.statements.at(-1).end);
    const body = inner
      .split("\n")
      .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
      .join("\n")
      .replace(/^\n+/, "");
    const call = `if (${spec.condition}) return ${spec.name}(lowerer, expr, loc);`;
    const fnText = `\n\nfunction ${spec.name}(lowerer: Lowerer, expr: ${spec.exprType}, loc: SrcLoc): IrExpr {\n  ${body.trimStart()}\n}`;
    text =
      text.slice(0, branch.getStart()) +
      call +
      text.slice(branch.end, fn.end) +
      fnText +
      text.slice(fn.end);
  }
  return text;
}

/* ── analysis ────────────────────────────────────────────────────────── */

function declNames(st) {
  if (
    ts.isFunctionDeclaration(st) ||
    ts.isClassDeclaration(st) ||
    ts.isInterfaceDeclaration(st) ||
    ts.isTypeAliasDeclaration(st) ||
    ts.isEnumDeclaration(st)
  )
    return st.name ? [st.name.text] : [];
  if (ts.isVariableStatement(st))
    return st.declarationList.declarations.flatMap((d) =>
      ts.isIdentifier(d.name) ? [d.name.text] : [],
    );
  return [];
}
const isExported = (st) =>
  st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
const isTypeDecl = (st) => ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st);
const isMutable = (st) =>
  ts.isVariableStatement(st) && !(st.declarationList.flags & ts.NodeFlags.Const);

function inTypePosition(node) {
  for (let n = node; n.parent; n = n.parent) {
    // A class's `extends` names a value; `implements` and an interface's
    // `extends` name types.
    if (ts.isExpressionWithTypeArguments(n) && ts.isHeritageClause(n.parent))
      return !(n.parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(n.parent.parent));
    if (ts.isTypeNode(n) || ts.isTypeQueryNode?.(n)) return true;
    if (ts.isStatement(n) || (ts.isExpression(n) && !ts.isIdentifier(n))) break;
  }
  return false;
}

/** For the module text: its statements with names, its import bindings, and
 * each declaration's references (local names and import bindings), each
 * marked type-only when every reference sits in a type position. */
function analyze(text) {
  const sf = parse(text);
  const host = confineHost(ts.createCompilerHost({}), checkout);
  const tsconfigPath = join(repo, config.tsconfig);
  checkout.check(tsconfigPath);
  const tsconfig = ts.getParsedCommandLineOfConfigFile(
    tsconfigPath,
    {},
    { ...confineHost(ts.sys, checkout), onUnRecoverableConfigFileDiagnostic: () => {} },
  );
  const options = { ...tsconfig.options, noEmit: true };
  const realGet = host.getSourceFile;
  host.getSourceFile = (fileName, lang, ...rest) =>
    resolve(fileName) === modulePath ? sf : realGet.call(host, fileName, lang, ...rest);
  const program = ts.createProgram([modulePath], options, host);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(modulePath);

  const imports = new Map(); // binding name -> { decl, spec, kind, typeOnly }
  const statements = [];
  for (const st of source.statements) {
    if (ts.isImportDeclaration(st)) {
      const clause = st.importClause;
      const typeOnlyDecl = clause?.isTypeOnly ?? false;
      if (clause?.name)
        imports.set(clause.name.text, {
          decl: st,
          kind: "default",
          typeOnly: typeOnlyDecl,
          node: clause,
        });
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb))
        imports.set(nb.name.text, {
          decl: st,
          kind: "namespace",
          typeOnly: typeOnlyDecl,
          node: nb,
        });
      if (nb && ts.isNamedImports(nb))
        for (const el of nb.elements)
          imports.set(el.name.text, {
            decl: st,
            kind: "named",
            typeOnly: typeOnlyDecl || el.isTypeOnly,
            node: el,
            imported: (el.propertyName ?? el.name).text,
          });
      continue;
    }
    statements.push({ node: st, names: declNames(st) });
  }
  const byNode = new Map();
  for (const s of statements) byNode.set(s.node, s);
  const ownerOf = (decl) => {
    for (let n = decl; n; n = n.parent) if (byNode.has(n)) return byNode.get(n);
    return undefined;
  };
  for (const s of statements) {
    const refs = new Map(); // name -> { kind: "local"|"import", typeOnly }
    const visit = (node) => {
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const isDeclName =
          parent &&
          parent.name === node &&
          (ts.isFunctionDeclaration(parent) ||
            ts.isVariableDeclaration(parent) ||
            ts.isInterfaceDeclaration(parent) ||
            ts.isTypeAliasDeclaration(parent) ||
            ts.isParameter(parent) ||
            ts.isPropertyAssignment(parent) ||
            ts.isPropertySignature(parent) ||
            ts.isPropertyDeclaration(parent) ||
            ts.isMethodDeclaration(parent) ||
            ts.isBindingElement(parent));
        const isPropertyName =
          parent &&
          ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
            (ts.isQualifiedName(parent) && parent.right === node));
        if (!isPropertyName) {
          let sym = checker.getSymbolAtLocation(node);
          if (ts.isShorthandPropertyAssignment(parent))
            sym = checker.getShorthandAssignmentValueSymbol(parent);
          const decl = sym?.declarations?.[0];
          if (decl && decl.getSourceFile() === source) {
            const typePos = inTypePosition(node);
            let target;
            if (
              ts.isImportSpecifier(decl) ||
              ts.isNamespaceImport(decl) ||
              ts.isImportClause(decl)
            ) {
              const name = (ts.isImportClause(decl) ? decl.name : decl.name).text;
              target = { name, kind: "import" };
            } else {
              const owner = ownerOf(decl);
              if (owner && owner !== s && !isDeclName) {
                const name = owner.names.find((n) => n === node.text) ?? node.text;
                if (owner.names.includes(name)) target = { name, kind: "local" };
              }
            }
            if (target) {
              const prev = refs.get(target.name);
              refs.set(target.name, {
                kind: target.kind,
                typeOnly: (prev ? prev.typeOnly : true) && typePos,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(s.node);
    s.refs = refs;
  }
  return { source, statements, imports };
}

/* ── plan ────────────────────────────────────────────────────────────── */

function plan() {
  const text = extractBranches(checkout.read(modulePath));
  const { statements } = analyze(text);
  const fileOf = new Map();
  for (const [file, names] of Object.entries(config.seeds))
    for (const name of names) {
      if (!statements.some((s) => s.names.includes(name)))
        throw new Error(`seed ${name} not found`);
      fileOf.set(name, file);
    }
  const keep = new Set(config.keep ?? []);
  const referrers = new Map();
  for (const s of statements)
    for (const [name, ref] of s.refs)
      if (ref.kind === "local") {
        if (!referrers.has(name)) referrers.set(name, new Set());
        for (const n of s.names) referrers.get(name).add(n);
      }
  for (let changed = true; changed;) {
    changed = false;
    for (const s of statements) {
      if (
        s.names.length === 0 ||
        s.names.some((n) => fileOf.has(n) || keep.has(n)) ||
        isMutable(s.node)
      )
        continue;
      const users = new Set();
      for (const n of s.names)
        for (const u of referrers.get(n) ?? []) if (!s.names.includes(u)) users.add(u);
      const files = new Set([...users].map((u) => fileOf.get(u) ?? null));
      if (users.size > 0 && files.size === 1 && !files.has(null)) {
        const [file] = files;
        for (const n of s.names) fileOf.set(n, file);
        changed = true;
      }
    }
  }
  const manifest = {};
  for (const s of statements) {
    const file = s.names.map((n) => fileOf.get(n)).find(Boolean);
    if (file) (manifest[file] ??= []).push(...s.names);
  }
  configFiles.write(config.manifest, JSON.stringify(manifest, null, 2) + "\n");
  for (const [file, names] of Object.entries(manifest)) console.log(`${file}: ${names.length}`);
}

/* ── apply ───────────────────────────────────────────────────────────── */

function rebase(spec, fromDir, toDir) {
  if (!spec.startsWith(".")) return spec;
  let rel = posix.normalize(relative(toDir, resolve(fromDir, spec)).split("\\").join("/"));
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}
const moduleSpecifierTo = (fromDir, file) => {
  let rel = relative(fromDir, file).split("\\").join("/").replace(/\.ts$/, ".js");
  return rel.startsWith(".") ? rel : "./" + rel;
};

/** The statement's text with its leading comments, without leading blank lines. */
function fullText(text, st) {
  return text.slice(st.getFullStart(), st.end).replace(/^\s*\n/, "");
}

function apply() {
  const manifest = JSON.parse(configFiles.read(config.manifest));
  let text = extractBranches(checkout.read(modulePath));
  const { source, statements, imports } = analyze(text);
  const fileOf = new Map();
  for (const [file, names] of Object.entries(manifest)) for (const n of names) fileOf.set(n, file);
  const stFile = (s) => s.names.map((n) => fileOf.get(n)).find(Boolean) ?? null;
  const nameFile = new Map();
  const nameStmt = new Map();
  for (const s of statements)
    for (const n of s.names) {
      nameFile.set(n, stFile(s));
      nameStmt.set(n, s);
    }

  // Which names need `export`: referenced from another file, or exported already.
  const needsExport = new Set();
  for (const s of statements)
    for (const [name, ref] of s.refs)
      if (ref.kind === "local" && nameFile.get(name) !== stFile(s)) needsExport.add(name);

  const files = new Map(); // file -> { decls: [], imports: Map<spec, {...}> }
  const fileImports = (file) => {
    if (!files.has(file)) files.set(file, { decls: [], named: new Map(), other: [] });
    return files.get(file);
  };
  const addNamed = (entry, spec, name, imported, typeOnly) => {
    if (!entry.named.has(spec)) entry.named.set(spec, new Map());
    const m = entry.named.get(spec);
    const prev = m.get(name);
    m.set(name, { imported, typeOnly: prev ? prev.typeOnly && typeOnly : typeOnly });
  };
  const moduleEntry = { decls: [], named: new Map(), other: [] };
  for (const s of statements) {
    const file = stFile(s);
    const entry = file ? fileImports(file) : moduleEntry;
    const dir = file ? dirname(join(moduleDir, file)) : moduleDir;
    if (file) {
      let t = fullText(text, s.node);
      if (!isExported(s.node) && s.names.some((n) => needsExport.has(n))) {
        const start = s.node.getStart() - s.node.getFullStart();
        const lead = text.slice(s.node.getFullStart(), s.node.getStart()).replace(/^\s*\n/, "");
        t = lead + "export " + text.slice(s.node.getStart(), s.node.end);
        void start;
      }
      entry.decls.push(t);
    }
    for (const [name, ref] of s.refs) {
      if (ref.kind === "local") {
        const target = nameFile.get(name) ?? null;
        if (target === file) continue;
        const targetPath = target ? join(moduleDir, target) : modulePath;
        const typeOnly = ref.typeOnly || isTypeDecl(nameStmt.get(name).node);
        addNamed(entry, moduleSpecifierTo(dir, targetPath), name, name, typeOnly);
      } else if (file) {
        const imp = imports.get(name);
        const spec = rebase(imp.decl.moduleSpecifier.text, moduleDir, dir);
        if (imp.kind === "named") addNamed(entry, spec, name, imp.imported, imp.typeOnly);
        else entry.other.push({ spec, kind: imp.kind, name, typeOnly: imp.typeOnly });
      }
    }
  }

  const renderImports = (entry) => {
    const lines = [];
    const seen = new Set();
    for (const o of entry.other) {
      const key = `${o.kind}:${o.name}:${o.spec}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(
        o.kind === "namespace"
          ? `import ${o.typeOnly ? "type " : ""}* as ${o.name} from "${o.spec}";`
          : `import ${o.typeOnly ? "type " : ""}${o.name} from "${o.spec}";`,
      );
    }
    for (const [spec, names] of entry.named) {
      const all = [...names.entries()];
      const allType = all.every(([, v]) => v.typeOnly);
      const parts = all
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(
          ([name, v]) =>
            `${!allType && v.typeOnly ? "type " : ""}${v.imported === name ? name : `${v.imported} as ${name}`}`,
        );
      lines.push(`import ${allType ? "type " : ""}{ ${parts.join(", ")} } from "${spec}";`);
    }
    return lines;
  };

  // New files.
  for (const [file, entry] of files) {
    const header = config.headers?.[file];
    const out = [
      ...(header ? [header] : []),
      ...renderImports(entry),
      "",
      entry.decls.join("\n\n"),
      "",
    ].join("\n");
    const path = join(moduleDir, file);
    checkout.mkdir(dirname(path));
    if (checkout.exists(path)) throw new Error(`${file} exists`);
    checkout.write(path, out);
  }

  // The module: drop moved declarations, rewrite its import block.
  const keptRefs = new Set();
  for (const s of statements)
    if (!stFile(s)) for (const [name, ref] of s.refs) if (ref.kind === "import") keptRefs.add(name);
  const pieces = [];
  let cursor = 0;
  const removals = [];
  for (const s of statements) if (stFile(s)) removals.push([s.node.getFullStart(), s.node.end]);
  // Import declarations: rebuild each without bindings nothing uses.
  const importEdits = [];
  for (const st of source.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    const clause = st.importClause;
    if (!clause) continue; // side-effect import
    const used = (n) => keptRefs.has(n);
    const def = clause.name && used(clause.name.text) ? clause.name.text : null;
    const nb = clause.namedBindings;
    let ns = null;
    let named = [];
    if (nb && ts.isNamespaceImport(nb) && used(nb.name.text)) ns = nb.name.text;
    if (nb && ts.isNamedImports(nb)) named = nb.elements.filter((el) => used(el.name.text));
    const keepAll =
      def === (clause.name?.text ?? null) &&
      (!nb || (ts.isNamespaceImport(nb) ? ns !== null : named.length === nb.elements.length));
    if (keepAll) continue;
    let replacement = "";
    if (def || ns || named.length) {
      const bits = [];
      if (def) bits.push(def);
      if (ns) bits.push(`* as ${ns}`);
      if (named.length) bits.push(`{ ${named.map((el) => el.getText()).join(", ")} }`);
      replacement = `import ${clause.isTypeOnly ? "type " : ""}${bits.join(", ")} from ${st.moduleSpecifier.getText()};`;
    }
    // A removed declaration takes its line break with it.
    const end = replacement === "" && text[st.end] === "\n" ? st.end + 1 : st.end;
    importEdits.push([st.getStart(), end, replacement]);
  }
  // Declarations that stay but that a moved one references get `export`.
  const exportEdits = [];
  for (const s of statements)
    if (!stFile(s) && !isExported(s.node) && s.names.some((n) => needsExport.has(n)))
      exportEdits.push([s.node.getStart(), s.node.getStart(), "export "]);
  const edits = [...removals.map(([a, b]) => [a, b, ""]), ...importEdits, ...exportEdits].sort(
    (x, y) => x[0] - y[0],
  );
  for (const [a, b, r] of edits) {
    pieces.push(text.slice(cursor, a), r);
    cursor = b;
  }
  pieces.push(text.slice(cursor));
  let moduleText = pieces.join("");
  // Imports of moved names the module still uses, and re-exports of moved
  // names that were exported (other modules import them from here).
  const addLines = renderImports(moduleEntry);
  const reexports = new Map();
  for (const s of statements) {
    const file = stFile(s);
    if (!file || !isExported(s.node)) continue;
    const spec = moduleSpecifierTo(moduleDir, join(moduleDir, file));
    if (!reexports.has(spec)) reexports.set(spec, []);
    for (const n of s.names) reexports.get(spec).push({ name: n, type: isTypeDecl(s.node) });
  }
  for (const [spec, names] of reexports) {
    const values = names
      .filter((n) => !n.type)
      .map((n) => n.name)
      .sort();
    const types = names
      .filter((n) => n.type)
      .map((n) => n.name)
      .sort();
    if (values.length) addLines.push(`export { ${values.join(", ")} } from "${spec}";`);
    if (types.length) addLines.push(`export type { ${types.join(", ")} } from "${spec}";`);
  }
  // Insert after the last import declaration.
  const reparsed = parse(moduleText);
  const lastImport = [...reparsed.statements].filter(ts.isImportDeclaration).at(-1);
  const at = lastImport ? lastImport.end : 0;
  moduleText =
    moduleText.slice(0, at) +
    (addLines.length ? "\n" + addLines.join("\n") : "") +
    moduleText.slice(at);
  moduleText = moduleText.replace(/\n{3,}/g, "\n\n");
  checkout.write(modulePath, moduleText);
  // Format what changed with the tools checkout's oxfmt, so the split and
  // every rehome of it are formatted the same way.
  const touched = [modulePath, ...[...files.keys()].map((f) => join(moduleDir, f))];
  formatFiles(toolsDir, touched, { cwd: repo, stdio: ["ignore", "ignore", "inherit"] });
  for (const [file, entry] of files) console.log(`${file}: ${entry.decls.length} declarations`);
}

if (command === "plan") plan();
else if (command === "apply") apply();
else {
  console.error("usage: split-module.mjs plan|apply <config.json>");
  process.exit(2);
}
