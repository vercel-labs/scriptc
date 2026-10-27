#!/usr/bin/env node
/* Move a group of LlEmitter fields into a feature's state object, as a
 * deterministic rewrite (the same config gives the same result on any
 * version of the tree, which the rehoming tool relies on).
 *
 *   node move-state.mjs apply <config.json> [--repo <dir>] [--tools <dir>]
 *
 * <config.json>:
 *   { "module": "packages/compiler/src/backend/llvm/emitter.ts",
 *     "class": "LlEmitter",
 *     "dir": "packages/compiler/src/backend/llvm",
 *     "groups": [{ "file": "loop-state.ts", "key": "LOOPS",
 *                  "fields": ["denseLoop", ...] }],
 *     "create": { "loop-state.ts": "loop-state.template.ts" },
 *     "replacements": [{ "file": "emit-function.ts", "find": "...", "replace": "...", "count": 1 }],
 *     "receivers": ["this", "emitter"] }
 *
 * For each group: the fields' declarations leave the class (their doc
 * comments and initializers move into the state object's interface and
 * factory in the group's file), every `this.<field>` and `emitter.<field>`
 * (or the config's receivers) in the directory's sources becomes
 * `<KEY>.of(this).<field>` / `<KEY>.of(emitter).<field>`, and each
 * rewritten file imports the key.
 * The group's file must already exist and hold everything else (header,
 * setup function); the tool appends the interface and key to it. */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { confine } from "./confine.mjs";
import { formatFiles } from "./format.mjs";

const [command, configPath, ...flags] = process.argv.slice(2);
if (command !== "apply") throw new Error("usage: move-state.mjs apply <config.json>");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const flag = (name) => {
  const i = flags.indexOf(name);
  return i >= 0 ? flags[i + 1] : undefined;
};
const repo = resolve(flag("--repo") ?? process.cwd());
const toolsDir = resolve(flag("--tools") ?? process.cwd());
const require = createRequire(join(toolsDir, "package.json"));
const ts = require("typescript");
const modulePath = join(repo, config.module);
const dir = join(repo, config.dir);
// Every read and write stays inside the checkout, or for the templates, the
// config's directory (confine.mjs).
const checkout = confine(repo);

// Adds an import line after the file's first block of imports (up to a
// blank line or other code).
const addImport = (text, line) => {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  let last;
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s)) break;
    if (last && /\n[ \t]*\n/.test(text.slice(last.getEnd(), s.getStart()))) break;
    last = s;
  }
  const at = last ? last.getEnd() + 1 : 0;
  return text.slice(0, at) + line + "\n" + text.slice(at);
};
const configDir = dirname(resolve(configPath));
const configFiles = confine(configDir);
// The names the class's instance goes by in the directory's sources.
const receivers = config.receivers ?? ["this", "emitter"];
const touched = new Set();
// Files the change creates, from templates next to the config (kept when a
// branch already has the file).
for (const [file, template] of Object.entries(config.create ?? {})) {
  const path = join(dir, file);
  if (checkout.exists(path)) continue;
  checkout.write(path, configFiles.read(join(configDir, template)));
  touched.add(path);
}
let moduleText = checkout.read(modulePath);
for (const group of config.groups) {
  const sf = ts.createSourceFile(modulePath, moduleText, ts.ScriptTarget.Latest, true);
  const cls = sf.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === config.class);
  if (!cls) throw new Error(`no class ${config.class}`);
  const wanted = new Set(group.fields);
  const members = [];
  for (const m of cls.members) {
    if (ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && wanted.has(m.name.text))
      members.push(m);
  }
  // A field the tree does not have yet (an older merge base) is left out, so
  // the move still applies there.
  const missing = group.fields.filter((f) => !members.some((m) => m.name.text === f));
  if (missing.length)
    console.warn(`${group.file}: fields not in ${config.class}: ${missing.join(", ")}; skipped`);
  group.present = members.map((m) => m.name.text);
  // Interface members and factory entries, in the class's order.
  const iface = [];
  const factory = [];
  for (const m of members) {
    const lead = moduleText.slice(m.getFullStart(), m.getStart()).replace(/^\s*\n/, "");
    const readonly = m.modifiers?.some((x) => x.kind === ts.SyntaxKind.ReadonlyKeyword)
      ? "readonly "
      : "";
    const name = m.name.text;
    if (!m.initializer)
      throw new Error(
        `${name}: a field without an initializer needs its constructor line moved by hand`,
      );
    // An unannotated field takes its initializer's type: a boolean,
    // number or string literal, or `new C<T>(...)`.
    const init = m.initializer;
    const type = m.type
      ? m.type.getText(sf)
      : init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword
        ? "boolean"
        : ts.isNumericLiteral(init)
          ? "number"
          : ts.isStringLiteral(init)
            ? "string"
            : ts.isNewExpression(init) && init.typeArguments?.length
              ? `${init.expression.getText(sf)}<${init.typeArguments.map((t) => t.getText(sf)).join(", ")}>`
              : null;
    if (type === null) throw new Error(`${name}: give the field a type annotation first`);
    iface.push(`${lead}  ${readonly}${name}: ${type};`);
    factory.push(`    ${name}: ${m.initializer.getText(sf)},`);
  }
  // Remove the declarations (with their leading comments) from the class.
  const cuts = members.map((m) => [m.getFullStart(), m.getEnd()]).sort((a, b) => b[0] - a[0]);
  for (const [s, e] of cuts) moduleText = moduleText.slice(0, s) + moduleText.slice(e);
  const iName = group.interface ?? `${group.key[0]}${group.key.slice(1).toLowerCase()}State`;
  const stateText =
    `\n/** The state ${group.key} holds on each emitter. */\n` +
    `export interface ${group.interfaceName ?? iName} {\n${iface.join("\n")}\n}\n\n` +
    `export const ${group.key} = defineModuleState<${group.interfaceName ?? iName}>(() => ({\n${factory.join("\n")}\n}));\n`;
  const groupPath = join(dir, group.file);
  let groupText = checkout.read(groupPath);
  if (!groupText.includes('from "./emitter-state.js"'))
    groupText = addImport(groupText, `import { defineModuleState } from "./emitter-state.js";`);
  groupText = groupText.trimEnd() + "\n" + stateText;
  checkout.write(groupPath, groupText);
  touched.add(groupPath);
  group.rename = group.present.length
    ? new RegExp(`(?<![\\w$.])(${receivers.join("|")})\\.(${group.present.join("|")})\\b`, "g")
    : null;
}
checkout.write(modulePath, moduleText);

// Rewrite accesses across the directory.
for (const file of checkout.list(dir).filter((f) => f.endsWith(".ts"))) {
  const path = join(dir, file);
  let text = path === modulePath ? moduleText : checkout.read(path);
  let changed = false;
  for (const group of config.groups) {
    if (!group.rename) continue;
    const next = text.replace(
      group.rename,
      (_, recv, field) => `${group.key}.of(${recv}).${field}`,
    );
    if (next === text) continue;
    text = next;
    changed = true;
    if (file === group.file) continue;
    const spec = `./${group.file.replace(/\.ts$/, ".js")}`;
    const existing = new RegExp(
      `^import \\{([^}]*)\\} from "${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}";$`,
      "m",
    );
    const m = existing.exec(text);
    if (m) {
      const names = new Set(
        m[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      names.add(group.key);
      text = text.replace(existing, `import { ${[...names].sort().join(", ")} } from "${spec}";`);
    } else {
      text = addImport(text, `import { ${group.key} } from "${spec}";`);
    }
  }
  if (changed) {
    checkout.write(path, text);
    touched.add(path);
  }
}
// The change's remaining edits, as literal replacements in order (the
// setup function call, imports, narrowing the rename loses). One whose text
// is not found as often as expected is reported and skipped: the branch
// changed that code, and the rehome's cherry-pick shows the difference.
let skipped = 0;
for (const r of config.replacements ?? []) {
  const path = join(dir, r.file);
  const text = checkout.exists(path) ? checkout.read(path) : "";
  const count = text.split(r.find).length - 1;
  if (count !== (r.count ?? 1)) {
    console.warn(
      `${r.file}: expected ${r.count ?? 1} of ${JSON.stringify(r.find.slice(0, 60))}, found ${count}; skipped`,
    );
    skipped++;
    continue;
  }
  checkout.write(path, text.split(r.find).join(r.replace));
  touched.add(path);
}
formatFiles(toolsDir, [...touched], { cwd: repo, stdio: "inherit" });
if (skipped) console.warn(`${skipped} replacement(s) skipped`);
console.log(
  `moved ${config.groups.map((g) => g.present.length).reduce((a, b) => a + b, 0)} fields; rewrote ${touched.size} files`,
);
