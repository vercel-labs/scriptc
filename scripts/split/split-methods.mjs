#!/usr/bin/env node
/* Move methods of one class into other files as functions of a host, as a
 * pure move.
 *
 *   node split-methods.mjs apply <config.json> [--repo <dir>] [--tools <dir>]
 *
 * <config.json>:
 *   { "tsconfig": "packages/compiler/tsconfig.json",
 *     "module": "packages/compiler/src/backend/llvm/emitter.ts",
 *     "class": "LlEmitter",
 *     "methods": { "emit-statements.ts": ["emitStmtBody", ...], ... },
 *     "headers": { "emit-statements.ts": "/* ... *\/" } }
 *
 * Each listed method becomes `export function <name>(host: <Class>, ...)`
 * in its file (relative to the module's directory), with its doc comment
 * and `this` replaced by the host parameter (`emitter`, or "hostName"). The class keeps a stub with the method's
 * signature that calls the function, so every caller is unchanged. Members
 * the moved bodies reach through `host` lose a `private` modifier (a
 * compile-time check only). Each new file imports what its functions
 * reference from the module's scope, with paths rebased; the module imports
 * the functions and drops imports nothing uses anymore. Names the config
 * lists but the class lacks are skipped. */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, posix } from "node:path";
import { createRequire } from "node:module";
import { confine, confineHost } from "./confine.mjs";
import { formatFiles } from "./format.mjs";

const [command, configPath, ...flags] = process.argv.slice(2);
if (command !== "apply") throw new Error("usage: split-methods.mjs apply <config.json>");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const flag = (name) => {
  const i = flags.indexOf(name);
  return i >= 0 ? flags[i + 1] : undefined;
};
const repo = resolve(flag("--repo") ?? process.cwd());
// Every read and write in the checkout stays inside it (confine.mjs).
const checkout = confine(repo);
const toolsDir = resolve(flag("--tools") ?? process.cwd());
const require = createRequire(join(toolsDir, "package.json"));
const ts = require("typescript");
const modulePath = join(repo, config.module);
const moduleDir = dirname(modulePath);
const className = config.class;
// The host parameter's name; a moved body that already uses it is refused.
const hostName = config.hostName ?? "emitter";

const text = checkout.read(modulePath);
const host = confineHost(ts.createCompilerHost({ noEmit: true }), checkout);
const sf = ts.createSourceFile(modulePath, text, ts.ScriptTarget.Latest, true);
const realGet = host.getSourceFile;
host.getSourceFile = (f, l, ...r) =>
  resolve(f) === modulePath ? sf : realGet.call(host, f, l, ...r);
const program = ts.createProgram([modulePath], { noEmit: true, noResolve: true }, host);
const checker = program.getTypeChecker();
const source = program.getSourceFile(modulePath);

const cls = source.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === className);
if (!cls) throw new Error(`no class ${className}`);
const memberByName = new Map();
for (const m of cls.members)
  if (m.name && ts.isIdentifier(m.name)) {
    if (!memberByName.has(m.name.text)) memberByName.set(m.name.text, []);
    memberByName.get(m.name.text).push(m);
  }

// Module scope: import bindings and top-level declarations.
const imports = new Map();
const topLevel = new Map();
for (const st of source.statements) {
  if (ts.isImportDeclaration(st)) {
    const c = st.importClause;
    if (!c) continue;
    if (c.name) imports.set(c.name.text, { st, kind: "default", typeOnly: c.isTypeOnly });
    const nb = c.namedBindings;
    if (nb && ts.isNamespaceImport(nb))
      imports.set(nb.name.text, { st, kind: "namespace", typeOnly: c.isTypeOnly });
    if (nb && ts.isNamedImports(nb))
      for (const el of nb.elements)
        imports.set(el.name.text, {
          st,
          kind: "named",
          typeOnly: c.isTypeOnly || el.isTypeOnly,
          imported: (el.propertyName ?? el.name).text,
        });
    continue;
  }
  const names = [];
  if (
    (ts.isFunctionDeclaration(st) ||
      ts.isClassDeclaration(st) ||
      ts.isInterfaceDeclaration(st) ||
      ts.isTypeAliasDeclaration(st) ||
      ts.isEnumDeclaration(st)) &&
    st.name
  )
    names.push(st.name.text);
  if (ts.isVariableStatement(st))
    for (const d of st.declarationList.declarations)
      if (ts.isIdentifier(d.name)) names.push(d.name.text);
  for (const n of names) topLevel.set(n, st);
}
const isExported = (st) =>
  st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
const isTypeDecl = (st) => ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st);

/** Module-scope references in `node`: name -> { kind: "import"|"local" }, and `this.<member>` names. */
function references(node) {
  const refs = new Map();
  const members = new Set();
  const visit = (n) => {
    if (
      n.kind === ts.SyntaxKind.ThisKeyword &&
      n.parent &&
      ts.isPropertyAccessExpression(n.parent) &&
      n.parent.expression === n
    )
      members.add(n.parent.name.text);
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const propName =
        p &&
        ((ts.isPropertyAccessExpression(p) && p.name === n) ||
          (ts.isQualifiedName(p) && p.right === n) ||
          (ts.isPropertyAssignment(p) && p.name === n));
      if (!propName) {
        let sym = checker.getSymbolAtLocation(n);
        if (p && ts.isShorthandPropertyAssignment(p))
          sym = checker.getShorthandAssignmentValueSymbol(p);
        const decl = sym?.declarations?.[0];
        if (decl && decl.getSourceFile() === source) {
          if (ts.isImportSpecifier(decl) || ts.isNamespaceImport(decl) || ts.isImportClause(decl))
            refs.set(decl.name.text, { kind: "import" });
          else if (
            topLevel.get(n.text) &&
            (decl === topLevel.get(n.text) ||
              decl.parent?.parent === topLevel.get(n.text) ||
              decl.parent === topLevel.get(n.text))
          )
            refs.set(n.text, { kind: "local" });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return { refs, members };
}

const rebase = (spec, toDir) => {
  if (!spec.startsWith(".")) return spec;
  let rel = posix.normalize(relative(toDir, resolve(moduleDir, spec)).split("\\").join("/"));
  return rel.startsWith(".") ? rel : "./" + rel;
};
const specTo = (fromDir, file) => {
  let rel = relative(fromDir, file).split("\\").join("/").replace(/\.ts$/, ".js");
  return rel.startsWith(".") ? rel : "./" + rel;
};

const edits = []; // [start, end, replacement] in the module
const stubs = [];
const files = new Map();
const publicize = new Set();
const moduleNeeds = new Map(); // spec -> names (functions the stubs call)
const exportLocals = new Set();
let moved = 0;

for (const [file, names] of Object.entries(config.methods)) {
  const path = join(moduleDir, file);
  const dir = dirname(path);
  const entry = { decls: [], named: new Map(), other: [] };
  const addNamed = (spec, name, imported, typeOnly) => {
    if (!entry.named.has(spec)) entry.named.set(spec, new Map());
    const m = entry.named.get(spec);
    const prev = m.get(name);
    m.set(name, { imported, typeOnly: prev ? prev.typeOnly && typeOnly : typeOnly });
  };
  addNamed(specTo(dir, modulePath), className, className, true);
  for (const name of names) {
    const decls = memberByName.get(name);
    if (!decls) {
      console.error(`skip: ${className}.${name} not found`);
      continue;
    }
    if (decls.length !== 1 || !ts.isMethodDeclaration(decls[0]) || !decls[0].body)
      throw new Error(`${name}: expected one method with a body`);
    const m = decls[0];
    if (m.typeParameters?.length || m.asteriskToken)
      throw new Error(`${name}: generic and generator methods are not handled`);
    const isAsync = m.modifiers?.some((x) => x.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
    // The function: doc comment, signature (initializers kept, so a
    // defaulted parameter after an optional one stays valid; the stub
    // passes every argument), and the body with this -> host.
    const lead = text.slice(m.getFullStart(), m.getStart()).replace(/^\s*\n/, "");
    const params = m.parameters.map((p) => {
      const nameText = p.name.getText();
      // A parameter typed only by its default takes the default's widened type.
      const type = p.type
        ? `: ${p.type.getText()}`
        : p.initializer
          ? `: ${checker.typeToString(checker.getBaseTypeOfLiteralType(checker.getTypeAtLocation(p.initializer)))}`
          : "";
      const optional = p.questionToken ? "?" : "";
      let init = "";
      if (p.initializer) {
        const initText = p.initializer.getText();
        if (/\bthis\b/.test(initText))
          throw new Error(`${name}: a parameter default that reads this is not handled`);
        init = ` = ${initText}`;
      }
      return `${p.dotDotDotToken ? "..." : ""}${nameText}${optional}${type}${init}`;
    });
    const ret = m.type ? `: ${m.type.getText()}` : "";
    const body = m.body;
    const thisEdits = [];
    const findThis = (n) => {
      // `this` in an expression, or in a type query (`typeof this.x`).
      // (In a type query `this` parses as an identifier.)
      if (
        n.kind === ts.SyntaxKind.ThisKeyword ||
        (ts.isIdentifier(n) && n.text === "this" && ts.findAncestor(n, ts.isTypeQueryNode))
      )
        thisEdits.push(n.getStart());
      if (ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isClassLike(n))
        throw new Error(`${name}: a nested function or class rebinds this`);
      ts.forEachChild(n, findThis);
    };
    ts.forEachChild(body, findThis);
    const clash = (n) => {
      if (ts.isIdentifier(n) && n.text === hostName)
        throw new Error(`${name}: already uses the name ${hostName}`);
      ts.forEachChild(n, clash);
    };
    clash(m);
    let bodyText = "";
    let cursor = body.getStart();
    for (const at of thisEdits.sort((a, b) => a - b)) {
      bodyText += text.slice(cursor, at) + hostName;
      cursor = at + 4;
    }
    bodyText += text.slice(cursor, body.end);
    const leadOut = lead
      .split("\n")
      .map((l) => (l.startsWith("  ") ? l.slice(2) : l))
      .join("\n");
    const fn = `${leadOut}export ${isAsync ? "async " : ""}function ${name}(${hostName}: ${className}${params.length ? ", " + params.join(", ") : ""})${ret} ${bodyText}`;
    entry.decls.push(fn);
    stubs.push(m);
    if (!moduleNeeds.has(specTo(moduleDir, path)))
      moduleNeeds.set(specTo(moduleDir, path), new Set());
    moduleNeeds.get(specTo(moduleDir, path)).add(name);
    // What the function needs.
    const { refs, members } = references(m);
    for (const member of members) publicize.add(member);
    for (const [ref, { kind }] of refs) {
      if (kind === "import") {
        const imp = imports.get(ref);
        const spec = rebase(imp.st.moduleSpecifier.text, dir);
        if (imp.kind === "named") addNamed(spec, ref, imp.imported, imp.typeOnly);
        else entry.other.push({ spec, kind: imp.kind, name: ref, typeOnly: imp.typeOnly });
      } else {
        const st = topLevel.get(ref);
        if (!isExported(st)) exportLocals.add(st);
        addNamed(specTo(dir, modulePath), ref, ref, isTypeDecl(st));
      }
    }
    moved++;
  }
  files.set(file, entry);
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
    const all = [...names.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const allType = all.every(([, v]) => v.typeOnly);
    const parts = all.map(
      ([n, v]) =>
        `${!allType && v.typeOnly ? "type " : ""}${v.imported === n ? n : `${v.imported} as ${n}`}`,
    );
    lines.push(`import ${allType ? "type " : ""}{ ${parts.join(", ")} } from "${spec}";`);
  }
  return lines;
};

for (const [file, entry] of files) {
  if (!entry.decls.length) continue;
  const path = join(moduleDir, file);
  if (checkout.exists(path)) throw new Error(`${file} exists`);
  const header = config.headers?.[file];
  checkout.write(
    path,
    [...(header ? [header] : []), ...renderImports(entry), "", entry.decls.join("\n\n"), ""].join(
      "\n",
    ),
  );
}

// Each moved method leaves a stub with its signature (defaults included)
// that calls the function; one the moved bodies call loses `private`.
const stubSet = new Set(stubs);
for (const m of stubs) {
  let signature = m.modifiers
    ? text.slice(m.getStart(), m.body.getStart()).trimEnd()
    : text.slice(m.getStart(), m.body.getStart()).trimEnd();
  if (publicize.has(m.name.text)) signature = signature.replace(/^private /, "");
  const args = m.parameters.map((p) => `${p.dotDotDotToken ? "..." : ""}${p.name.getText()}`);
  const call = `${m.name.text}(this${args.length ? ", " + args.join(", ") : ""})`;
  edits.push([m.getFullStart(), m.end, `\n  ${signature} {\n    return ${call};\n  }`]);
}
// Other members the moved bodies reach through the host lose `private`.
for (const name of publicize)
  for (const m of memberByName.get(name) ?? [])
    if (!stubSet.has(m))
      for (const mod of m.modifiers ?? [])
        if (mod.kind === ts.SyntaxKind.PrivateKeyword)
          edits.push([mod.getStart(), mod.end + 1, ""]);
// Top-level declarations the new files import get `export`.
for (const st of exportLocals) edits.push([st.getStart(), st.getStart(), "export "]);

let out = "";
let cursor = 0;
for (const [a, b, r] of edits.sort((x, y) => x[0] - y[0])) {
  out += text.slice(cursor, a) + r;
  cursor = b;
}
out += text.slice(cursor);

// Re-analyze the rewritten module for unused imports, then add the new ones.
const sf2 = ts.createSourceFile(modulePath, out, ts.ScriptTarget.Latest, true);
const host2 = confineHost(ts.createCompilerHost({ noEmit: true }), checkout);
const get2 = host2.getSourceFile;
host2.getSourceFile = (f, l, ...r) =>
  resolve(f) === modulePath ? sf2 : get2.call(host2, f, l, ...r);
const program2 = ts.createProgram([modulePath], { noEmit: true, noResolve: true }, host2);
const checker2 = program2.getTypeChecker();
const src2 = program2.getSourceFile(modulePath);
const used = new Set();
const walk = (n) => {
  if (
    ts.isIdentifier(n) &&
    !(n.parent && ts.isImportSpecifier(n.parent)) &&
    !(n.parent && ts.isImportClause(n.parent)) &&
    !(n.parent && ts.isNamespaceImport(n.parent))
  ) {
    const sym =
      n.parent && ts.isShorthandPropertyAssignment(n.parent)
        ? checker2.getShorthandAssignmentValueSymbol(n.parent)
        : checker2.getSymbolAtLocation(n);
    const d = sym?.declarations?.[0];
    if (d && (ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d)))
      used.add(d.name.text);
  }
  ts.forEachChild(n, walk);
};
for (const st of src2.statements) if (!ts.isImportDeclaration(st)) walk(st);
const importEdits = [];
for (const st of src2.statements) {
  if (!ts.isImportDeclaration(st) || !st.importClause) continue;
  const c = st.importClause;
  const def = c.name && used.has(c.name.text) ? c.name.text : null;
  const nb = c.namedBindings;
  const ns = nb && ts.isNamespaceImport(nb) && used.has(nb.name.text) ? nb.name.text : null;
  const named =
    nb && ts.isNamedImports(nb) ? nb.elements.filter((el) => used.has(el.name.text)) : [];
  const all =
    (c.name ? def !== null : true) &&
    (!nb || (ts.isNamespaceImport(nb) ? ns !== null : named.length === nb.elements.length));
  if (all) continue;
  let r = "";
  if (def || ns || named.length) {
    const bits = [];
    if (def) bits.push(def);
    if (ns) bits.push(`* as ${ns}`);
    if (named.length) bits.push(`{ ${named.map((el) => el.getText()).join(", ")} }`);
    r = `import ${c.isTypeOnly ? "type " : ""}${bits.join(", ")} from ${st.moduleSpecifier.getText()};`;
  }
  const end = r === "" && out[st.end] === "\n" ? st.end + 1 : st.end;
  importEdits.push([st.getStart(), end, r]);
}
let final = "";
cursor = 0;
for (const [a, b, r] of importEdits.sort((x, y) => x[0] - y[0])) {
  final += out.slice(cursor, a) + r;
  cursor = b;
}
final += out.slice(cursor);
const lastImport = [
  ...ts.createSourceFile(modulePath, final, ts.ScriptTarget.Latest, true).statements,
]
  .filter(ts.isImportDeclaration)
  .at(-1);
const add = [...moduleNeeds].map(
  ([spec, names]) => `import { ${[...names].sort().join(", ")} } from "${spec}";`,
);
const at = lastImport ? lastImport.end : 0;
final = final.slice(0, at) + (add.length ? "\n" + add.join("\n") : "") + final.slice(at);
checkout.write(modulePath, final);
// Format what changed with the tools checkout's oxfmt, so the split and
// every rehome of it are formatted the same way.
const touched = [
  modulePath,
  ...[...files].filter(([, e]) => e.decls.length).map(([f]) => join(moduleDir, f)),
];
formatFiles(toolsDir, touched, { cwd: repo, stdio: ["ignore", "ignore", "inherit"] });
console.log(`${moved} methods moved; ${publicize.size} members reached through host`);
