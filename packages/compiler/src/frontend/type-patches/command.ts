/* `scriptc types patch` and `scriptc types list`: write and inspect the
 * project's type patches (package.json scriptc.typePatches).
 *
 *   scriptc types patch <package> <selector> <type> [--range <r>] [--dry-run]
 *   scriptc types list
 *
 * `patch` finds the installed package from the working directory, shows
 * every declaration the selector matches (in the package's declaration
 * files, its JSDoc and its @types package) with its type before and after,
 * and adds the patch to the nearest package.json under a range covering
 * the installed version (`^<version>` unless --range says otherwise, or an
 * existing entry's range when one covers it). Nothing is written when the
 * selector matches nothing. `list` shows each configured patch, the
 * installed copies it applies to and what it matches. */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseProjectConfig, type TypePatchEntry } from "../../project-config.js";
import type { TypePatchParse } from "./layer.js";
import { patchFile, type PatchMatch } from "./locate.js";
import { parseSelector, parseTypeText, type Selector, type TypePatchOp } from "./selector.js";
import { isValidRange, satisfies } from "./semver.js";

export type TypePatchCommandRequest =
  | {
      action: "patch";
      cwd: string;
      pkg: string;
      selector: string;
      type: string;
      range: string | null;
      dryRun: boolean;
    }
  | { action: "list"; cwd: string };

export interface TypePatchCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface PackageCopy {
  root: string;
  version: string | null;
  /** True for an `@types/<name>` twin. */
  twin: boolean;
}

const PATCHABLE = /\.(?:[cm]?js|d\.[cm]?ts|[cm]?ts)$/;

function nearestManifest(cwd: string): string | null {
  for (let dir = cwd; ;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) return manifest;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function versionOf(root: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function typesName(pkg: string): string {
  return pkg.startsWith("@") ? `@types/${pkg.slice(1).replace("/", "__")}` : `@types/${pkg}`;
}

/** The copy of `pkg` (and of its @types twin) Node resolution finds from
 * `cwd`. A twin is versioned by the runtime package beside it. */
function installedCopies(cwd: string, pkg: string): PackageCopy[] {
  const out: PackageCopy[] = [];
  let runtimeVersion: string | null = null;
  let twinFound = false;
  for (let dir = cwd; ;) {
    const modules = join(dir, "node_modules");
    if (runtimeVersion === null && existsSync(join(modules, pkg, "package.json"))) {
      const root = join(modules, pkg);
      runtimeVersion = versionOf(root);
      out.push({ root, version: runtimeVersion, twin: false });
    }
    if (!twinFound && existsSync(join(modules, typesName(pkg), "package.json"))) {
      twinFound = true;
      out.push({ root: join(modules, typesName(pkg)), version: null, twin: true });
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const copy of out) if (copy.twin) copy.version = runtimeVersion ?? versionOf(copy.root);
  return out;
}

/** The files of a package copy a patch can apply to (nested packages
 * excluded), package-relative. */
function packageFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const path = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(path);
      else if (PATCHABLE.test(name)) out.push(relative(root, path).split("\\").join("/"));
    }
  };
  walk(root);
  return out;
}

interface FileMatch extends PatchMatch {
  file: string;
}

/** Every declaration a selector matches in a copy, and the problems where
 * it cannot apply (`always`: a problem even where the selector matched
 * elsewhere, such as an ambiguous replacement, which leaves those
 * declarations as they are). */
function matchCopy(
  copy: PackageCopy,
  selector: Selector,
  op: TypePatchOp,
  parse: TypePatchParse,
): { matches: FileMatch[]; problems: { message: string; always: boolean }[] } {
  const words =
    selector.root === "export="
      ? ["exports", "export"]
      : selector.root === "default"
        ? ["default"]
        : [selector.root];
  const matches: FileMatch[] = [];
  const problems: { message: string; always: boolean }[] = [];
  for (const rel of packageFiles(copy.root)) {
    if (selector.file !== null && selector.file !== rel) continue;
    const path = join(copy.root, rel);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (!words.some((w) => text.includes(w))) continue;
    let result;
    try {
      result = patchFile(rel, text, parse(path, text, /\.[cm]?ts$/.test(rel) ? "ts" : "js"), [
        { id: 0, selector, op },
      ]);
    } catch {
      continue;
    }
    for (const m of result.matches) matches.push({ ...m, file: rel });
    for (const p of result.problems)
      problems.push({ message: `${p.message} (${rel})`, always: p.always === true });
  }
  return { matches, problems };
}

function shownCopy(copy: PackageCopy, base: string, pkg: string): string {
  const name = copy.twin ? typesName(pkg) : pkg;
  return `${name} ${copy.version ?? "(no version)"} (${relative(base, copy.root).split("\\").join("/")})`;
}

function describe(m: FileMatch): string {
  if (m.redundant) return `  ${m.file}:${m.line}  ${m.before}  (already declared so)`;
  return `  ${m.file}:${m.line}  ${m.before}  ->  ${m.after}`;
}

/** The indentation a JSON text uses (two spaces when it cannot tell). */
function indentOf(text: string): string {
  const m = /^[{[]\s*\n([ \t]+)\S/.exec(text);
  return m === null ? "  " : m[1]!;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** JSON text of `value` with `path` set to the string `leaf` (objects
 * created along the way, the leaf replaced if present), keeping key order
 * and indenting like JSON.stringify(value, null, indent). The parsed value
 * itself is only read. */
function renderJson(
  value: unknown,
  indent: string,
  at: string,
  path: readonly string[],
  leaf: string,
): string {
  const inner = at + indent;
  if (path.length > 0 && !isObject(value)) return renderJson({}, indent, at, path, leaf);
  if (isObject(value)) {
    const keys = Object.keys(value);
    const parts: string[] = [];
    const head = path[0];
    for (const k of keys) {
      const child =
        head === k
          ? path.length === 1
            ? JSON.stringify(leaf)
            : renderJson(value[k], indent, inner, path.slice(1), leaf)
          : renderJson(value[k], indent, inner, [], leaf);
      parts.push(`${inner}${JSON.stringify(k)}: ${child}`);
    }
    if (head !== undefined && !keys.includes(head)) {
      const child =
        path.length === 1
          ? JSON.stringify(leaf)
          : renderJson({}, indent, inner, path.slice(1), leaf);
      parts.push(`${inner}${JSON.stringify(head)}: ${child}`);
    }
    return parts.length === 0 ? "{}" : `{\n${parts.join(",\n")}\n${at}}`;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    if (items.length === 0) return "[]";
    return `[\n${items.map((item) => `${inner}${renderJson(item, indent, inner, [], leaf)}`).join(",\n")}\n${at}]`;
  }
  return JSON.stringify(value) ?? "null";
}

function patchCommand(
  req: Extract<TypePatchCommandRequest, { action: "patch" }>,
  parse: TypePatchParse,
): TypePatchCommandResult {
  const fail = (message: string): TypePatchCommandResult => ({
    stdout: "",
    stderr: `scriptc: ${message}\n`,
    exitCode: 1,
  });
  const selector = parseSelector(req.selector);
  if ("error" in selector) return fail(`'${req.selector}' is not a selector: it ${selector.error}`);
  const op = parseTypeText(req.type);
  if ("error" in op) return fail(`the type '${req.type}' ${op.error}`);
  if (req.range !== null && !isValidRange(req.range))
    return fail(`'${req.range}' is not a semver range`);
  const manifest = nearestManifest(req.cwd);
  if (manifest === null) return fail("no package.json found from the working directory");
  const base = dirname(manifest);
  const copies = installedCopies(req.cwd, req.pkg);
  const runtime = copies.find((c) => !c.twin) ?? copies[0];
  if (runtime === undefined) return fail(`${req.pkg} is not installed here`);
  const version = runtime.version;
  const lines: string[] = [];
  let matched = 0;
  let changed = 0;
  const problems: { message: string; always: boolean }[] = [];
  for (const copy of copies) {
    const found = matchCopy(copy, selector, op, parse);
    problems.push(...found.problems);
    if (found.matches.length === 0) continue;
    lines.push(shownCopy(copy, base, req.pkg));
    for (const m of found.matches) {
      lines.push(describe(m));
      matched++;
      if (!m.redundant) changed++;
    }
  }
  if (matched === 0) {
    const why =
      problems.length > 0
        ? problems.map((p) => p.message).join("\n")
        : `'${req.selector}' matches no declaration`;
    return fail(`${why}\nnothing was written`);
  }
  // A declaration the patch cannot apply to where it also matched (an
  // ambiguous replacement) would stay as it is.
  const unapplied = problems.filter((p) => p.always);
  if (unapplied.length > 0)
    return fail(`${unapplied.map((p) => p.message).join("\n")}\nnothing was written`);
  const text = readFileSync(manifest, "utf8");
  // The compiler applies every entry whose range covers the installed
  // version, and a later entry wins on the same selector. Without a range,
  // the patch goes to the last covering entry that patches the selector
  // already, else to the first covering entry; with one, to the entry of
  // that range. Otherwise a new entry, which comes last, takes it.
  const entries = parseProjectConfig(manifest, text).typePatches.filter(
    (e: TypePatchEntry) => e.pkg === req.pkg,
  );
  const covers = (e: TypePatchEntry): boolean => version !== null && satisfies(version, e.range);
  const declares = (e: TypePatchEntry): boolean =>
    e.declarations.some((d) => d.selector === req.selector);
  // The declarations may say this already while a covering entry patches
  // the selector to something else, which the build would keep using.
  const overridden = entries.some(
    (e) =>
      covers(e) && e.declarations.some((d) => d.selector === req.selector && d.type !== req.type),
  );
  if (changed === 0 && !overridden) {
    lines.push("the declarations already say this; nothing was written");
    return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(`${relative(req.cwd, manifest) || "package.json"} is not valid JSON`);
  }
  const existing =
    req.range === null
      ? (entries.findLast((e) => covers(e) && declares(e)) ?? entries.find(covers))
      : entries.find((e) => e.range === req.range);
  if (existing !== undefined && covers(existing)) {
    const later = entries
      .slice(entries.indexOf(existing) + 1)
      .find((e) => covers(e) && declares(e));
    if (later !== undefined)
      return fail(
        `scriptc.typePatches["${later.key}"] also patches '${req.selector}' for ${req.pkg} ${version} and takes precedence over scriptc.typePatches["${existing.key}"]\nnothing was written`,
      );
  }
  const key =
    existing?.key ?? `${req.pkg}@${req.range ?? (version === null ? "*" : `^${version}`)}`;
  const where = `scriptc.typePatches["${key}"].declarations["${req.selector}"]`;
  if (req.dryRun) {
    lines.push(`would write ${relative(req.cwd, manifest) || "package.json"} ${where}`);
    return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
  }
  const trailing = text.endsWith("\n") ? "\n" : "";
  writeFileSync(
    manifest,
    renderJson(
      parsed,
      indentOf(text),
      "",
      ["scriptc", "typePatches", key, "declarations", req.selector],
      req.type,
    ) + trailing,
  );
  lines.push(`wrote ${relative(req.cwd, manifest) || "package.json"} ${where}`);
  return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
}

function listCommand(cwd: string, parse: TypePatchParse): TypePatchCommandResult {
  const manifest = nearestManifest(cwd);
  if (manifest === null)
    return {
      stdout: "",
      stderr: "scriptc: no package.json found from the working directory\n",
      exitCode: 1,
    };
  const base = dirname(manifest);
  const config = parseProjectConfig(manifest, readFileSync(manifest, "utf8"));
  const lines: string[] = [];
  for (const d of config.diagnostics)
    if (d.message.includes("typePatches")) lines.push(`warning ${d.code}: ${d.message}`);
  if (config.typePatches.length === 0) {
    lines.push("no type patches");
    return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
  }
  for (const entry of config.typePatches) {
    lines.push(entry.key);
    const copies = installedCopies(cwd, entry.pkg);
    const covered = copies.filter((c) => c.version !== null && satisfies(c.version, entry.range));
    if (copies.length === 0) lines.push(`  not installed`);
    else if (covered.length === 0)
      lines.push(
        `  does not apply to the installed ${entry.pkg} ${copies[0]!.version ?? "(no version)"}`,
      );
    for (const decl of entry.declarations) {
      const selector = parseSelector(decl.selector) as Selector;
      const op = parseTypeText(decl.type) as TypePatchOp;
      const found: FileMatch[] = [];
      for (const copy of covered) {
        for (const m of matchCopy(copy, selector, op, parse).matches)
          found.push({
            ...m,
            file: `${relative(base, copy.root).split("\\").join("/")}/${m.file}`,
          });
      }
      const status =
        covered.length === 0
          ? ""
          : found.length === 0
            ? "  (matches nothing)"
            : found.every((m) => m.redundant)
              ? "  (already declared so)"
              : "";
      lines.push(`  ${decl.selector}: ${decl.type}${status}`);
      for (const m of found)
        if (!m.redundant) lines.push(`    ${m.file}:${m.line}  ${m.before}  ->  ${m.after}`);
    }
    for (const [target, local] of entry.files)
      lines.push(`  file ${target}: ${relative(base, local).split("\\").join("/")}`);
    if (entry.types !== null)
      lines.push(`  types: ${relative(base, entry.types).split("\\").join("/")}`);
  }
  return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
}

export function runTypePatchCommand(
  req: TypePatchCommandRequest,
  parse: TypePatchParse,
): TypePatchCommandResult {
  return req.action === "patch" ? patchCommand(req, parse) : listCommand(req.cwd, parse);
}
