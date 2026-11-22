#!/usr/bin/env node
/* Re-apply an open branch's edits to the shared tables onto the split layout.
 *
 * The three shared tables were split into one file per builtin module:
 *
 *   internal/compatibility/static-support.json is now the index of
 *   internal/compatibility/static-support/{chapter-policies.json,
 *   evidence/, features/, dedicated/};
 *
 *   packages/compiler/src/ir/builtin-signatures.ts is now the index of
 *   packages/compiler/src/ir/builtin-signatures/<prefix>.ts;
 *
 *   packages/compiler/src/ir/builtin-never-throw.ts is now the index of
 *   packages/compiler/src/ir/builtin-never-throw/<prefix>.ts.
 *
 * A branch written against the old single files is rehomed by taking its
 * change from the merge base to its tip and re-applying it to the split
 * files. The unit is the entry, not the text: an entry added, removed or
 * changed in the old file becomes the same add, remove or change in the
 * per-module file, whatever the surrounding formatting. Nothing is lost when
 * this repository's own main moved since the branch was cut: entries main
 * added after the branch are left alone.
 *
 *   node scripts/rehome-split-tables.mjs --pr 4009            report only
 *   node scripts/rehome-split-tables.mjs --pr 4009 --write    apply
 *   node scripts/rehome-split-tables.mjs --ref some/branch --write
 *   node scripts/rehome-split-tables.mjs --pr 4009 --write --no-format
 *
 * Apply it to a clean working tree, then run the table's own gates
 * (`pnpm node-compat --local` for static-support, a compiler build for the
 * two compiler tables) before committing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url))) + "/";
const git = (...args) =>
  execFileSync("git", args, { cwd: root, maxBuffer: 256 * 1024 * 1024 }).toString();

const SIG_OLD = "packages/compiler/src/ir/builtin-signatures.ts";
const SIG_DIR = "packages/compiler/src/ir/builtin-signatures";
const NT_OLD = "packages/compiler/src/ir/builtin-never-throw.ts";
const NT_DIR = "packages/compiler/src/ir/builtin-never-throw";
const STATIC_OLD = "internal/compatibility/static-support.json";
const STATIC_DIR = "internal/compatibility/static-support";

/** A chapter is a Node module chapter slug and a builtin prefix is the call
 * name's first segment. Both become file names, so a value that came from a
 * branch is accepted only when it is one plain path segment. */
export const CHAPTER_NAME = /^[a-z0-9][a-z0-9_-]*$/;
export const PREFIX_NAME = /^[A-Za-z][A-Za-z0-9]*$/;
export const EVIDENCE_MODULE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The only files and directories this script may read, write or remove. */
const TABLE_ROOTS = [STATIC_OLD, STATIC_DIR, SIG_OLD, SIG_DIR, NT_OLD, NT_DIR];

export function assertTableName(kind, name, pattern) {
  if (typeof name !== "string" || !pattern.test(name)) {
    throw new Error(`rehome: refusing unsafe ${kind} name ${JSON.stringify(name)}`);
  }
  return name;
}

/** Refuse any path that is not under one of the split table's own files or
 * directories. `join` normalizes `..`, so containment has to be checked
 * before joining, not after. */
export function assertTablePath(rel) {
  const normalized = rel.replace(/\\/g, "/");
  const under = TABLE_ROOTS.some(
    (tableRoot) => normalized === tableRoot || normalized.startsWith(`${tableRoot}/`),
  );
  const absolute = resolve(root, normalized);
  const base = resolve(root);
  if (
    normalized.startsWith("/") ||
    normalized.split("/").includes("..") ||
    !under ||
    !(absolute === base || absolute.startsWith(`${base}${sep}`))
  ) {
    throw new Error(`rehome: refusing path outside the table directories: ${rel}`);
  }
  return normalized;
}

let dryRun = false;
const read = (rel) => readFileSync(join(root, assertTablePath(rel)), "utf8");
const writeOut = (rel, text) => {
  const path = assertTablePath(rel);
  if (!dryRun) writeFileSync(join(root, path), text);
};
const removeOut = (rel) => {
  const path = assertTablePath(rel);
  if (!dryRun && existsSync(join(root, path))) rmSync(join(root, path));
};
const show = (ref, rel) => {
  try {
    return git("show", `${ref}:${rel}`);
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------ */
/* Shared text helpers                                                 */
/* ------------------------------------------------------------------ */

/** An import in the repository's formatter style. */
function renderImport(names, from) {
  const one = `import { ${names.join(", ")} } from "${from}";`;
  if (one.length <= 100) return one;
  return ["import {", ...names.map((name) => `  ${name},`), `} from "${from}";`].join("\n");
}

function dedent(line) {
  return line.startsWith("  ") ? line.slice(2) : line;
}

function stripForUsage(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

function usedImportNames(text, vocabulary) {
  const clean = stripForUsage(text);
  return vocabulary.filter((name) => new RegExp(`\\b${name}\\b`).test(clean));
}

/* ------------------------------------------------------------------ */
/* builtin-signatures.ts                                               */
/* ------------------------------------------------------------------ */

/** Entry chunks of a `defineLibFnSignatures({ ... })` literal, keyed by
 * builtin name, with the comments and blank lines that precede each. */
export function parseTsObjectEntries(text, label) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.includes("defineLibFnSignatures({"));
  if (start < 0) throw new Error(`${label}: no defineLibFnSignatures literal`);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\}\);\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error(`${label}: unterminated object literal`);
  const firstEntry = lines
    .slice(start + 1, end)
    .find((line) => /^\s+"(?:[^"\\]|\\.)+":\s*\{/.test(line));
  if (!firstEntry) throw new Error(`${label}: no entries`);
  const indent = firstEntry.match(/^(\s+)"/)[1];
  const chunks = [];
  let pending = [];
  let i = start + 1;
  while (i < end) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*(\/\/|\/\*|\*)/.test(line)) {
      pending.push(line);
      i++;
      continue;
    }
    if (!line.startsWith(`${indent}"`)) {
      throw new Error(`${label}: unexpected line ${i + 1}: ${line}`);
    }
    const key = line.trim().match(/^"((?:[^"\\]|\\.)+)":/)[1];
    let j = i;
    let depth = 0;
    let started = false;
    for (; j < end; j++) {
      let inString = false;
      let escaped = false;
      for (const character of lines[j]) {
        if (inString) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') inString = true;
        else if (character === "{") {
          depth++;
          started = true;
        } else if (character === "}") depth--;
      }
      if (started && depth === 0) {
        j++;
        break;
      }
    }
    chunks.push({
      key,
      prefix: key.split(".")[0],
      indent: indent.length,
      text: [...pending, ...lines.slice(i, j)].join("\n"),
    });
    pending = [];
    i = j;
  }
  const rebuilt = chunks.map((chunk) => chunk.text).join("\n");
  if (pending.some((line) => line.trim() !== "")) throw new Error(`${label}: trailing text`);
  if (rebuilt !== lines.slice(start + 1, end).join("\n")) {
    throw new Error(`${label}: entry parse did not cover the literal`);
  }
  return chunks;
}

function signatureIrVocabulary(texts) {
  const names = [];
  for (const text of texts) {
    const re = /import (?:type )?\{([^}]*)\} from "[./]*ir\.js";/g;
    let match;
    while ((match = re.exec(text))) {
      for (const part of match[1].split(",")) {
        const name = part.trim();
        if (name && name !== "IrType" && !names.includes(name)) names.push(name);
      }
    }
  }
  return names;
}

/** Rendered at the old file's four-space entry indentation, so a chunk from
 * a module file can be compared with a chunk lifted from the old file. */
function atOldIndent(chunk) {
  const shift = 4 - chunk.indent;
  if (shift === 0) return chunk.text;
  return chunk.text
    .split("\n")
    .map((line) => {
      if (line === "") return line;
      const leading = line.match(/^ */)[0].length;
      if (shift > 0) return " ".repeat(shift) + line;
      return line.slice(Math.min(-shift, leading));
    })
    .join("\n");
}

/** The names a module file currently imports from ir.js, in source order. */
function irImportNames(text) {
  const names = [];
  const re = /^import \{([^}]*)\} from "\.\.\/ir\.js";/gm;
  let match;
  while ((match = re.exec(text))) {
    for (const part of match[1].split(",")) {
      const name = part.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

export function moduleChunks(rel) {
  return parseTsObjectEntries(read(rel), rel).map((chunk) => ({
    ...chunk,
    indent: 4,
    text: atOldIndent(chunk),
  }));
}

export function renderSignatureModule(prefix, entries, vocabulary) {
  // Entries are stored at the old file's four-space indent; module files
  // indent their body one level less.
  const body = entries
    .map((entry) =>
      entry.text
        .split("\n")
        .map((line) => dedent(line))
        .join("\n"),
    )
    .join("\n");
  const names = usedImportNames(body, vocabulary);
  const header = [];
  if (names.length > 0) header.push(renderImport(names, "../ir.js"));
  header.push(`import { defineLibFnSignatures } from "./shared.js";`);
  return [
    ...header,
    "",
    `/** The ${prefix} builtin call slots. */`,
    `export const ${prefix}Signatures = defineLibFnSignatures({`,
    body,
    "});",
    "",
  ].join("\n");
}

/** Rewrite the index's import and spread lines for `prefixes`, keeping every
 * other line (the documentation) as it is. */
function updateSignatureIndex(prefixes) {
  for (const prefix of prefixes) assertTableName("builtin prefix", prefix, PREFIX_NAME);
  const lines = read(SIG_OLD).split("\n");
  const fnIndex = lines.findIndex((line) => line.startsWith("function buildLibFnSignatures"));
  if (fnIndex < 0) throw new Error(`${SIG_OLD}: no buildLibFnSignatures`);
  let docEnd = fnIndex - 1;
  while (docEnd >= 0 && lines[docEnd].trim() === "") docEnd--;
  let docStart = docEnd;
  while (docStart >= 0 && !lines[docStart].trim().startsWith("/**")) docStart--;
  const doc = lines.slice(docStart, fnIndex);
  const close = lines.findIndex((line, index) => index > fnIndex && line === "}");
  const rest = lines.slice(close + 1);
  const exportType =
    lines.find((line) => line.startsWith("export type { LibFnSignature }")) ??
    `export type { LibFnSignature } from "./builtin-signatures/shared.js";`;
  writeOut(
    SIG_OLD,
    [
      ...prefixes.map(
        (prefix) => `import { ${prefix}Signatures } from "./builtin-signatures/${prefix}.js";`,
      ),
      "",
      exportType,
      "",
      ...doc,
      "function buildLibFnSignatures() {",
      "  return {",
      ...prefixes.map((prefix) => `    ...${prefix}Signatures,`),
      "  };",
      "}",
      ...rest,
    ].join("\n"),
  );
}

/* ------------------------------------------------------------------ */
/* builtin-never-throw.ts                                              */
/* ------------------------------------------------------------------ */

export function parseNeverThrow(text, label, marker = "new Set<IrLibFn>([", closer = /^\s*\]\);/) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.includes(marker));
  if (start < 0) throw new Error(`${label}: no ${marker} literal`);
  // The repository formatter collapses a one-element array onto one line.
  const inline = lines[start].match(/= \[(.*)\];\s*$/);
  if (inline) {
    return [...inline[1].matchAll(/"((?:[^"\\]|\\.)+)"/g)].map((match) => ({
      key: match[1],
      prefix: match[1].split(".")[0],
      text: `  "${match[1]}",`,
    }));
  }
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (closer.test(lines[i])) {
      end = i;
      break;
    }
  }
  const chunks = [];
  let pending = [];
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    const match = line.match(/^(\s*)"((?:[^"\\]|\\.)+)",\s*$/);
    if (match) {
      chunks.push({
        key: match[2],
        prefix: match[2].split(".")[0],
        text: [...pending, line].join("\n"),
      });
      pending = [];
    } else if (/^\s*$/.test(line) || /^\s*\/\//.test(line)) {
      pending.push(line);
    } else {
      throw new Error(`${label}: unexpected line ${i + 1}: ${line}`);
    }
  }
  if (pending.some((line) => line.trim() !== "")) throw new Error(`${label}: trailing text`);
  if (chunks.map((chunk) => chunk.text).join("\n") !== lines.slice(start + 1, end).join("\n")) {
    throw new Error(`${label}: entry parse did not cover the literal`);
  }
  return chunks;
}

/** The builtin name of an entry chunk (the last non-blank line). */
export function entryName(text) {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines[lines.length - 1].trim().slice(1).replace(/",?$/, "");
}

export function moduleNeverThrowChunks(rel) {
  return parseNeverThrow(read(rel), rel, "readonly IrLibFn[] = [", /^\s*\];/);
}

export function renderNeverThrowModule(prefix, entries) {
  return [
    `import type { IrLibFn } from "../builtin-signatures.js";`,
    "",
    `/** The builtins in the ${prefix} module decided never to throw. */`,
    `export const ${prefix}NeverThrow: readonly IrLibFn[] = [`,
    entries.map((entry) => entry.text).join("\n"),
    "];",
    "",
  ].join("\n");
}

function updateNeverThrowIndex(prefixes) {
  for (const prefix of prefixes) assertTableName("builtin prefix", prefix, PREFIX_NAME);
  const lines = read(NT_OLD).split("\n");
  const exportIndex = lines.findIndex((line) =>
    line.startsWith("export const NEVER_THROW_LIB_FNS"),
  );
  if (exportIndex < 0) throw new Error(`${NT_OLD}: no NEVER_THROW_LIB_FNS`);
  let docEnd = exportIndex - 1;
  while (docEnd >= 0 && lines[docEnd].trim() === "") docEnd--;
  let docStart = docEnd;
  while (docStart >= 0 && !lines[docStart].trim().startsWith("/**")) docStart--;
  const doc = lines.slice(docStart, exportIndex);
  const close = lines.findIndex((line, index) => index > exportIndex && /^\s*\]\);/.test(line));
  const rest = lines.slice(close + 1);
  writeOut(
    NT_OLD,
    [
      `import type { IrLibFn } from "./builtin-signatures.js";`,
      ...prefixes.map(
        (prefix) => `import { ${prefix}NeverThrow } from "./builtin-never-throw/${prefix}.js";`,
      ),
      "",
      ...doc,
      lines[exportIndex],
      ...prefixes.map((prefix) => `  ...${prefix}NeverThrow,`),
      "]);",
      ...rest,
    ].join("\n"),
  );
}

/* ------------------------------------------------------------------ */
/* static-support.json                                                 */
/* ------------------------------------------------------------------ */

function staticBlock(lines, key) {
  const start = lines.findIndex((line) => new RegExp(`^\\s*"${key}":\\s*[{[]`).test(line));
  if (start < 0) throw new Error(`static-support: no ${key}`);
  const closer = lines[start].includes("[") ? "]" : "}";
  let end = start + 1;
  while (!new RegExp(`^\\s*\\${closer},?\\s*$`).test(lines[end])) end++;
  return { start, end };
}

/** One array/object per line inside a block: the line without its trailing
 * comma is the entry's identity and its rendering. */
function staticLines(lines, start, end) {
  const out = [];
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    out.push(line.replace(/,\s*$/, ""));
  }
  return out;
}

function renderStaticPart(entries, opener, closer) {
  return [
    `${opener}`,
    entries.map((entry, index) => (index === entries.length - 1 ? entry : `${entry},`)).join("\n"),
    `${closer}`,
    "",
  ].join("\n");
}

/** Split a whole old static-support.json into part path -> entry lines. */
export function splitStatic(text, label) {
  const lines = text.split("\n");
  const parts = new Map();
  const policies = staticBlock(lines, "chapterPolicies");
  parts.set("static-support/chapter-policies.json", {
    opener: "{",
    closer: "}",
    entries: staticLines(lines, policies.start, policies.end),
  });

  const evidence = staticBlock(lines, "evidenceByManifestPrefix");
  for (const entry of staticLines(lines, evidence.start, evidence.end)) {
    const key = Object.keys(JSON.parse(`{${entry}}`))[0];
    const module = assertTableName(
      "evidence module",
      (key.startsWith("node-builtin.") ? key.split(".")[1] : key.split(".")[0]).replace(/\//g, "-"),
      EVIDENCE_MODULE,
    );
    const part = `static-support/evidence/${module}.json`;
    assertTablePath(`internal/compatibility/${part}`);
    if (!parts.has(part)) parts.set(part, { opener: "{", closer: "}", entries: [] });
    parts.get(part).entries.push(entry);
  }

  for (const [key, dir, opener, closer] of [
    ["features", "features", "[", "]"],
    ["dedicated", "dedicated", "[", "]"],
  ]) {
    const block = staticBlock(lines, key);
    for (const entry of staticLines(lines, block.start, block.end)) {
      const value = JSON.parse(entry);
      const name =
        value.chapter === undefined
          ? "_unassigned"
          : assertTableName("chapter", value.chapter, CHAPTER_NAME);
      const part = `static-support/${dir}/${name}.json`;
      assertTablePath(`internal/compatibility/${part}`);
      if (!parts.has(part)) parts.set(part, { opener, closer, entries: [] });
      parts.get(part).entries.push(entry);
    }
  }
  if (parts.size === 0) throw new Error(`${label}: nothing parsed`);
  return parts;
}

function readStaticPart(path) {
  const text = read(path);
  return text
    .split("\n")
    .filter(
      (line) =>
        line.trim() !== "" &&
        line.trim() !== "[" &&
        line.trim() !== "]" &&
        line.trim() !== "{" &&
        line.trim() !== "}",
    )
    .map((line) => line.replace(/,\s*$/, ""));
}

/* ------------------------------------------------------------------ */
/* Entry-level merge                                                   */
/* ------------------------------------------------------------------ */

/** The multiset of entry texts that `tip` has and `base` does not. */
export function addedTexts(baseTexts, tipTexts) {
  const remaining = new Map();
  for (const text of baseTexts) remaining.set(text, (remaining.get(text) ?? 0) + 1);
  const added = [];
  for (const text of tipTexts) {
    const count = remaining.get(text) ?? 0;
    if (count > 0) remaining.set(text, count - 1);
    else added.push(text);
  }
  return added;
}

export function removedTexts(baseTexts, tipTexts) {
  return addedTexts(tipTexts, baseTexts);
}

/** Apply a multiset delta to `ours`, appending additions. */
export function applyDelta(ours, removed, added) {
  const counts = new Map();
  for (const text of removed) counts.set(text, (counts.get(text) ?? 0) + 1);
  const kept = [];
  const missing = [];
  for (const text of ours) {
    const count = counts.get(text) ?? 0;
    if (count > 0) counts.set(text, count - 1);
    else kept.push(text);
  }
  for (const [text, count] of counts) if (count > 0 && !missing.includes(text)) missing.push(text);
  return { result: [...kept, ...added], missing };
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

function rehomeSignatures(baseText, tipText, report) {
  const base = parseTsObjectEntries(baseText, "origin merge-base builtin-signatures");
  const tip = parseTsObjectEntries(tipText, "branch builtin-signatures");
  const baseByKey = new Map(base.map((chunk) => [chunk.key, chunk]));
  const tipByKey = new Map(tip.map((chunk) => [chunk.key, chunk]));

  const files = readdirSync(join(root, SIG_DIR)).filter(
    (file) => file.endsWith(".ts") && file !== "shared.ts",
  );
  const byPrefix = new Map();
  for (const file of files) {
    const prefix = file.slice(0, -3);
    byPrefix.set(prefix, moduleChunks(`${SIG_DIR}/${file}`));
  }
  const vocabulary = signatureIrVocabulary([
    ...files.map((file) => read(`${SIG_DIR}/${file}`)),
    baseText,
    tipText,
  ]);

  let changedParts = 0;
  const touched = new Set();
  for (const [key, chunk] of tipByKey) {
    const before = baseByKey.get(key);
    if (before && before.text === chunk.text) continue; // unchanged by the branch
    touched.add(chunk.prefix);
  }
  for (const key of baseByKey.keys())
    if (!tipByKey.has(key)) touched.add(baseByKey.get(key).prefix);

  for (const prefix of touched) {
    assertTableName("builtin prefix", prefix, PREFIX_NAME);
    const ours = byPrefix.get(prefix) ?? [];
    const result = [];
    for (const entry of ours) {
      const tipEntry = tipByKey.get(entry.key);
      if (tipEntry) {
        if (tipEntry.text !== baseByKey.get(entry.key)?.text)
          result.push({ ...entry, text: tipEntry.text });
        else result.push(entry);
      } else if (baseByKey.has(entry.key)) {
        // The branch deleted it.
      } else {
        result.push(entry); // added by main after the branch
      }
    }
    const seen = new Set(result.map((entry) => entry.key));
    const additions = [];
    for (const chunk of tip) {
      if (chunk.prefix !== prefix || baseByKey.has(chunk.key) || seen.has(chunk.key)) continue;
      additions.push({ ...chunk, text: chunk.text.split("\n").map(dedent).join("\n") });
      seen.add(chunk.key);
    }
    const final = [...result, ...additions];
    for (const key of droppedSignatureEdits(prefix, tipByKey.keys(), baseByKey, seen)) {
      report.missing.push(
        `signature ${key}: the branch edits it but main no longer has it; inspect by hand`,
      );
    }
    const file = `${SIG_DIR}/${prefix}.ts`;
    if (final.length === 0) {
      removeOut(file);
      continue;
    }
    const existing = existsSync(join(root, file)) ? irImportNames(read(file)) : [];
    const moduleVocabulary = [
      ...existing,
      ...vocabulary.filter((name) => !existing.includes(name)),
    ];
    const text = renderSignatureModule(prefix, final, moduleVocabulary);
    if (!existsSync(join(root, assertTablePath(file))) || read(file) !== text) {
      writeOut(file, text);
      changedParts++;
    }
  }
  if (touched.size > 0) {
    const prefixes = readdirSync(join(root, SIG_DIR))
      .filter((file) => file.endsWith(".ts") && file !== "shared.ts")
      .map((file) => file.slice(0, -3))
      .sort();
    updateSignatureIndex(prefixes);
  }
  report.tables.push({
    table: "builtin-signatures",
    changed: touched.size,
    added: [...tip].filter((chunk) => !baseByKey.has(chunk.key)).length,
    removed: [...base].filter((chunk) => !tipByKey.has(chunk.key)).length,
    replaced: [...tip].filter(
      (chunk) => baseByKey.has(chunk.key) && baseByKey.get(chunk.key).text !== chunk.text,
    ).length,
    prefixes: [...touched].sort(),
  });
}

/** The branch's edited keys in `prefix` that this prefix's split file did
 * not receive: present in the merge base and the branch tip, absent from the
 * placed result. Only the prefix's own keys are considered; a table-wide scan
 * would report every other module's unchanged entries as missing. */
export function droppedSignatureEdits(prefix, tipKeys, baseKeys, placedKeys) {
  return [...tipKeys].filter(
    (key) => key.split(".")[0] === prefix && baseKeys.has(key) && !placedKeys.has(key),
  );
}

function rehomeNeverThrow(baseText, tipText, report) {
  const base = parseNeverThrow(baseText, "origin merge-base builtin-never-throw");
  const tip = parseNeverThrow(tipText, "branch builtin-never-throw");
  const baseTexts = base.map((chunk) => chunk.text);
  const tipTexts = tip.map((chunk) => chunk.text);
  const added = addedTexts(baseTexts, tipTexts);
  const removed = removedTexts(baseTexts, tipTexts);
  const touched = new Set([...added, ...removed].map((text) => entryName(text).split(".")[0]));

  const files = readdirSync(join(root, NT_DIR)).filter((file) => file.endsWith(".ts"));
  const byPrefix = new Map();
  for (const file of files)
    byPrefix.set(file.slice(0, -3), moduleNeverThrowChunks(`${NT_DIR}/${file}`));

  for (const prefix of touched) {
    assertTableName("builtin prefix", prefix, PREFIX_NAME);
    const ours = byPrefix.get(prefix) ?? [];
    // Names are the identity: a comment changed on main since the branch does
    // not turn a deletion into a duplicate.
    const baseByName = new Map(base.map((chunk) => [entryName(chunk.text), chunk.text]));
    const tipByName = new Map(
      tip
        .filter((chunk) => chunk.prefix === prefix)
        .map((chunk) => [entryName(chunk.text), chunk.text]),
    );
    const result = [];
    for (const chunk of ours) {
      const name = entryName(chunk.text);
      if (!tipByName.has(name) && baseByName.has(name)) continue; // the branch deleted it
      const tipText = tipByName.get(name);
      if (tipText !== undefined && tipText !== baseByName.get(name)) result.push({ text: tipText });
      else result.push(chunk);
    }
    const present = new Set(result.map((chunk) => entryName(chunk.text)));
    for (const [name, text] of tipByName) {
      if (!baseByName.has(name) && !present.has(name)) result.push({ text });
    }
    const finalNames = new Set(result.map((chunk) => entryName(chunk.text)));
    for (const name of tipByName.keys()) {
      if (baseByName.has(name) && !finalNames.has(name))
        report.missing.push(
          `never-throw ${name}: the branch edits it but main no longer has it; inspect by hand`,
        );
    }
    const file = `${NT_DIR}/${prefix}.ts`;
    if (result.length === 0) {
      removeOut(file);
      continue;
    }
    writeOut(file, renderNeverThrowModule(prefix, result));
  }
  if (touched.size > 0) {
    const prefixes = readdirSync(join(root, NT_DIR))
      .filter((file) => file.endsWith(".ts"))
      .map((file) => file.slice(0, -3))
      .sort();
    updateNeverThrowIndex(prefixes);
  }
  report.tables.push({
    table: "builtin-never-throw",
    added: added.length,
    removed: removed.length,
    prefixes: [...touched].sort(),
  });
}

/** The identity of one static-support entry: the manifest prefix, the
 * chapter policy's chapter, a dedicated row's symbols, or a feature row's
 * chapter, parent and row names. An edited row keeps its identity. */
export function staticEntryKey(path, text) {
  const trimmed = text.trim();
  const value = JSON.parse(trimmed.startsWith("{") ? trimmed : `{${trimmed}}`);
  if (path.endsWith("chapter-policies.json") || path.includes("/evidence/"))
    return Object.keys(value)[0];
  if (path.includes("/dedicated/")) return JSON.stringify(value.symbols);
  return [
    value.chapter,
    value.parent ?? "",
    JSON.stringify(value.signatures ?? value.symbols),
  ].join("\u0000");
}

/** The rows of `ours` that survive deleting the branch's rows in `before`:
 * a row's identity, not its text, decides. Rows main added (no identity in
 * `before`) stay. */
export function keepRowsAfterDeletion(path, before, ours) {
  const deleted = new Set(before.map((text) => staticEntryKey(path, text)));
  return ours.filter((text) => !deleted.has(staticEntryKey(path, text)));
}

function rehomeStaticSupport(baseText, tipText, report) {
  const base = splitStatic(baseText, "origin merge-base static-support");
  const tip = splitStatic(tipText, "branch static-support");
  let changed = 0;
  for (const [path, tipPart] of tip) {
    const basePart = base.get(path);
    const before = basePart?.entries ?? [];
    if (basePart && JSON.stringify(before) === JSON.stringify(tipPart.entries)) continue;
    const rel = `internal/compatibility/${path}`;
    const ours = existsSync(join(root, rel)) ? readStaticPart(rel) : [];
    const beforeByKey = new Map(before.map((text) => [staticEntryKey(path, text), text]));
    const tipByKey = new Map(tipPart.entries.map((text) => [staticEntryKey(path, text), text]));
    const result = [];
    for (const text of ours) {
      const key = staticEntryKey(path, text);
      if (!tipByKey.has(key) && beforeByKey.has(key)) continue; // the branch deleted it
      const tipText = tipByKey.get(key);
      result.push(tipText !== undefined && tipText !== beforeByKey.get(key) ? tipText : text);
    }
    const present = new Set(result.map((text) => staticEntryKey(path, text)));
    for (const [key, text] of tipByKey) {
      if (present.has(key)) continue;
      if (beforeByKey.has(key)) {
        report.missing.push(`${path}: the branch edits a row main no longer has; inspect by hand`);
        continue;
      }
      // The branch added this row, but main may have reshaped the same rows
      // since the branch was cut. Sharing a parent heading is ordinary;
      // claiming one of the same rows is a conflict worth a look.
      if (path.includes("/features/") || path.includes("/dedicated/")) {
        const value = JSON.parse(text);
        const names = new Set(value.signatures ?? value.symbols ?? []);
        const overlaps = (candidate) => {
          const other = JSON.parse(candidate);
          return (other.signatures ?? other.symbols ?? []).some((name) => names.has(name));
        };
        const clash = result.find(overlaps);
        if (clash) {
          const other = JSON.parse(clash);
          const shared = (other.signatures ?? other.symbols ?? []).filter((name) =>
            names.has(name),
          );
          report.missing.push(
            `${path}: the branch adds ${shared.slice(0, 3).join(", ")} which main already claims; inspect by hand`,
          );
        }
      }
      result.push(text);
    }
    if (result.length === 0) {
      removeOut(rel);
      continue;
    }
    writeOut(rel, renderStaticPart(result, tipPart.opener, tipPart.closer));
    changed++;
  }
  for (const path of base.keys()) {
    if (tip.has(path)) continue;
    const basePart = base.get(path);
    if (basePart.entries.length === 0) continue;
    const rel = `internal/compatibility/${path}`;
    const ours = existsSync(join(root, rel)) ? readStaticPart(rel) : [];
    // The branch deleted its rows; a row main added after the branch was cut
    // is not the branch's row to delete.
    const kept = keepRowsAfterDeletion(path, basePart.entries, ours);
    if (kept.length === ours.length) continue;
    if (kept.length === 0) removeOut(rel);
    else writeOut(rel, renderStaticPart(kept, basePart.opener, basePart.closer));
    changed++;
  }
  report.tables.push({ table: "static-support", changed });
}

/* ------------------------------------------------------------------ */
/* Driver                                                              */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { write: false, format: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--write") args.write = true;
    else if (arg === "--no-format") args.format = false;
    else if (arg === "--json") args.json = true;
    else if (arg === "--pr") args.pr = argv[++i];
    else if (arg === "--ref") args.ref = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.pr && !args.ref)) {
    console.log(
      "usage: node scripts/rehome-split-tables.mjs --pr NUMBER [--write] [--no-format] [--json]",
    );
    return;
  }
  const ref = args.ref ?? `refs/remotes/pull/${args.pr}`;
  if (!args.ref) {
    try {
      git("rev-parse", "--verify", ref);
    } catch {
      git("fetch", "origin", `pull/${args.pr}/head:${ref}`);
    }
  }
  const base = git("merge-base", "origin/main", ref).trim();
  const report = { pr: args.pr ?? ref, base, tables: [], missing: [] };
  const note = (text) => console.log(args.json ? "" : text);
  dryRun = !args.write;

  const oldFiles = [
    {
      rel: SIG_OLD,
      dir: SIG_DIR,
      run: () => rehomeSignatures(show(base, SIG_OLD), show(ref, SIG_OLD), report),
      marker: "defineLibFnSignatures({",
    },
    {
      rel: NT_OLD,
      dir: NT_DIR,
      run: () => rehomeNeverThrow(show(base, NT_OLD), show(ref, NT_OLD), report),
      marker: "new Set<IrLibFn>([",
    },
    {
      rel: STATIC_OLD,
      dir: STATIC_DIR,
      run: () => rehomeStaticSupport(show(base, STATIC_OLD), show(ref, STATIC_OLD), report),
      marker: '"chapterPolicies"',
    },
  ];
  for (const table of oldFiles) {
    if (!existsSync(join(root, table.dir)) || !existsSync(join(root, table.rel))) {
      note(`${table.rel}: split layout not present; skipped`);
      continue;
    }
    const before = show(base, table.rel);
    const after = show(ref, table.rel);
    if (before === null || after === null) {
      note(
        `${table.rel}: missing on ${before === null ? "the merge base" : "the branch"}; skipped`,
      );
      continue;
    }
    if (before === after) {
      report.tables.push({ table: table.rel, changed: 0 });
      continue;
    }
    table.run();
  }

  if (args.write && args.format) {
    const paths = [SIG_OLD, NT_OLD, SIG_DIR, NT_DIR];
    try {
      execFileSync("pnpm", ["exec", "oxfmt", "--write", ...paths], { cwd: root, stdio: "ignore" });
    } catch {
      console.log("warning: oxfmt failed; run `pnpm exec oxfmt --write` on the changed files");
    }
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const entry of report.tables) console.log(JSON.stringify(entry));
    if (report.missing.length > 0)
      console.log(
        `entries not found in the split files (inspect by hand):\n  ${report.missing.join("\n  ")}`,
      );
    if (!args.write) console.log("dry run: pass --write to apply");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
