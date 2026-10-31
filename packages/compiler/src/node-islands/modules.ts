/* The island module tree: the JavaScript a program's Node island calls load,
 * collected at build time and shipped with the executable, so a deployed
 * binary never reads modules from the machine that built it.
 *
 * Each `call`/`callSync` names its module with a string literal. The build
 * resolves it from the calling module as Node's require() does:
 * - a relative or absolute specifier names a module of the program: the
 *   module and every module its string-literal `require()` (also through a
 *   `createRequire()` function), `import` and `export ... from` reach are
 *   collected; a computed specifier in such a module is refused, since the
 *   build cannot know what it loads;
 * - a package specifier names a package: its whole directory is collected
 *   (computed requires inside packages keep working), and so are its
 *   `dependencies`, `optionalDependencies` and `peerDependencies`, the
 *   packages its "imports" map to and the packages its JavaScript names
 *   with string literals, all found as Node finds them;
 * - a Node built-in module needs nothing, and neither does a module the
 *   build cannot find: loading it throws MODULE_NOT_FOUND when the call
 *   runs, as under Node.
 * A load of a resolved file (`requireModule` and the compiler's own Node
 * islands, lower-node-island.ts) collects the package that holds the file
 * the same way, or, for a module of the program, the module and what it
 * loads; the load then names the file by its path in the tree.
 * Paths keep their layout relative to one root directory (the deepest
 * directory that holds every collected path, above any node_modules
 * directory, where Node looks for packages), with symbolic links between
 * package directories (pnpm's layout) kept as links. Only these relative
 * paths enter the executable. Every read goes through the frontend input
 * tracker, so an edit to an island module invalidates cached builds. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  trackedAccessibleEntries,
  trackedDirectoryExists,
  trackedFileExists,
  trackedReadBytes,
  trackedReadFile,
  trackedRealpath,
} from "../frontend/input-tracker.js";
import type { IrNodeIslandModules } from "../ir/ir.js";
import { packageDirOf } from "./origin.js";

export type NodeIslandModuleTree = IrNodeIslandModules;
type NodeIslandModuleFile = IrNodeIslandModules["files"][number];
type NodeIslandModuleLink = IrNodeIslandModules["links"][number];

const BUILTINS: ReadonlySet<string> = new Set(builtinModules);

/** Extensions require() tries for an extensionless file, in its order. */
const FILE_EXTENSIONS = [".js", ".json", ".node"];

/** Module files whose imports are traced. */
const TRACED = /\.(?:[cm]?js|[cm]?ts)$/;

/** A package's JavaScript files, whose imports of other packages are followed. */
const SCRIPT = /\.[cm]?js$/;

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || BUILTINS.has(specifier);
}

function isPathSpecifier(specifier: string): boolean {
  return (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    isAbsolute(specifier)
  );
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** The file require() loads for `base` (a file, an extension away, or a
 * directory with a package.json main or an index file), or null. */
function resolveFile(base: string): string | null {
  if (trackedFileExists(base)) return base;
  for (const extension of FILE_EXTENSIONS)
    if (trackedFileExists(base + extension)) return base + extension;
  if (!trackedDirectoryExists(base)) return null;
  const manifest = trackedReadFile(join(base, "package.json"));
  if (manifest !== null) {
    let main: unknown;
    try {
      main = (JSON.parse(manifest) as { main?: unknown }).main;
    } catch {
      main = undefined;
    }
    if (typeof main === "string" && main !== "") {
      const target = join(base, main);
      const found = resolveFile(target) ?? resolveFile(join(target, "index"));
      if (found !== null) return found;
    }
  }
  for (const extension of FILE_EXTENSIONS) {
    const index = join(base, `index${extension}`);
    if (trackedFileExists(index)) return index;
  }
  return null;
}

/** The directory of package `name` as require() finds it from `fromDir`:
 * `node_modules/<name>` in `fromDir` and each ancestor not itself named
 * node_modules. */
function packageDirectory(fromDir: string, name: string): string | null {
  for (let dir = fromDir; ;) {
    if (basename(dir) !== "node_modules") {
      const candidate = join(dir, "node_modules", name);
      if (trackedDirectoryExists(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The package.json nearest to `dir`, as Node finds a module's package
 * scope, or null. */
function packageScope(dir: string): string | null {
  for (let at = dir; ;) {
    if (basename(at) === "node_modules") return null;
    const candidate = join(at, "package.json");
    if (trackedFileExists(candidate)) return candidate;
    const parent = dirname(at);
    if (parent === at) return null;
    at = parent;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The deepest directory that contains every path. */
function commonDirectory(paths: readonly string[]): string {
  let common = paths[0]!.split(sep);
  for (const path of paths.slice(1)) {
    const parts = path.split(sep);
    let n = 0;
    while (n < common.length && n < parts.length && common[n] === parts[n]) n++;
    common = common.slice(0, n);
  }
  const joined = common.join(sep);
  return joined === "" ? sep : joined;
}

/** The string targets of a package.json "imports" map, through its
 * conditions and fallback arrays. */
function importTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(importTargets);
  if (value !== null && typeof value === "object")
    return Object.values(value).flatMap(importTargets);
  return [];
}

function portable(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

export class NodeIslandModuleCollector {
  /** Real paths of collected files. */
  private readonly files = new Set<string>();
  /** Link path (its directory real) → real target. */
  private readonly links = new Map<string, string>();
  private readonly packages = new Set<string>();
  private readonly traced = new Set<string>();
  /** Real paths of the calling modules. */
  private readonly callers = new Set<string>();
  /** Real paths of the files loads name (addLoaded, addProvided). */
  private readonly loaded = new Set<string>();
  /** Program modules whose source the program provides (addProvided). */
  private readonly provided = new Set<string>();
  /** The problems addNamedData reported (isDataFileProblem). */
  private readonly dataProblems = new Set<string>();

  /** Whether `problem`, returned by add or addLoaded, is a data file the
   * build does not ship (addNamedData) rather than a module. */
  isDataFileProblem(problem: string): boolean {
    return this.dataProblems.has(problem);
  }

  /** Collects the module `specifier` names from `caller` (a real path).
   * Returns null, or the reason the build cannot ship it. */
  add(caller: string, specifier: string): string | null {
    this.callers.add(caller);
    return this.resolveFrom(caller, specifier);
  }

  /** Collects the module a load names by its resolved path (a real path):
   * the package that holds it, or a module of the program with what it
   * loads. Returns null, or the reason the build cannot ship it. */
  addLoaded(file: string): string | null {
    this.loaded.add(file);
    const at = packageDirOf(file);
    if (at !== null) {
      this.addPackage(at.dir);
      return null;
    }
    return this.addModule(this.placed(file));
  }

  /** Collects a module whose source the program provides (a shared module,
   * runtime scr_node_island_hooks.cjs): Node still resolves it to its file,
   * so its package is in the tree, or, for a program module, a placeholder
   * at its path (providedModulePlaceholder): the program's source stays out
   * of the executable. Island code that imports it loads the program's
   * module too, so it is not traced either. */
  addProvided(file: string): void {
    this.loaded.add(file);
    const at = packageDirOf(file);
    if (at !== null) this.addPackage(at.dir);
    else {
      const placed = this.placed(file);
      this.files.add(placed);
      this.provided.add(placed);
    }
  }

  /** The collected tree, or null when no call loads a file. */
  tree(): NodeIslandModuleTree | null {
    if (this.files.size === 0 && this.links.size === 0) return null;
    const anchors = [
      ...this.files,
      ...this.links.keys(),
      ...this.links.values(),
      ...[...this.callers].map((caller) => dirname(caller)),
      ...[...this.loaded].map((file) => dirname(file)),
    ];
    // Node finds a package through the node_modules directory that holds
    // it, so a root inside one moves above it.
    let root = commonDirectory(anchors);
    const parts = root.split(sep);
    const outer = parts.indexOf("node_modules");
    if (outer >= 0) root = parts.slice(0, outer).join(sep) || sep;
    const files: NodeIslandModuleFile[] = [];
    for (const file of [...this.files].sort()) {
      const path = portable(relative(root, file));
      if (this.provided.has(file)) {
        const bytes = providedModulePlaceholder(path);
        files.push({ path, size: bytes.length, sha256: sha256(bytes), placeholder: true });
        continue;
      }
      const bytes = trackedReadBytes(file);
      if (bytes === null) continue;
      files.push({ path, size: bytes.length, sha256: sha256(bytes) });
    }
    const links: NodeIslandModuleLink[] = [...this.links]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, target]) => ({
        path: portable(relative(root, path)),
        target: portable(relative(dirname(path), target)),
      }));
    return { root, files, links };
  }

  /** The tree path a caller's module has: relative to the tree root. */
  static callerPath(tree: NodeIslandModuleTree | null, caller: string): string {
    return tree === null ? basename(caller) : portable(relative(tree.root, caller));
  }

  /** The name a load gives a collected file: `./` and its path relative to
   * the tree root (the runtime resolves it under the root). */
  static loadPath(tree: NodeIslandModuleTree | null, file: string): string {
    return tree === null ? file : `./${portable(relative(tree.root, file))}`;
  }

  private resolveFrom(fromFile: string, specifier: string): string | null {
    if (isBuiltin(specifier)) return null;
    if (specifier.startsWith("#"))
      return `'${specifier}' is a package import ("imports" in package.json), which Node island modules of the program cannot use`;
    if (specifier.startsWith("file:") || /^[a-z][a-z0-9+.-]*:/i.test(specifier))
      return `'${specifier}' is a URL; name the module by its relative path or package name`;
    // A module the build cannot find is not shipped: loading it throws
    // MODULE_NOT_FOUND when the call runs, as it does under Node (an
    // optional require in a try block keeps working).
    if (isPathSpecifier(specifier)) {
      const target = resolveFile(resolve(dirname(fromFile), specifier));
      return target === null ? null : this.addModule(this.placed(target));
    }
    const dir = packageDirectory(dirname(fromFile), packageName(specifier));
    if (dir !== null) this.addPackage(dir);
    return null;
  }

  /** The real path of `path`, recording a link for each component of it
   * that is a symbolic link (a linked directory on the way, or the file
   * itself), so that the path resolves inside the tree as it does here. */
  private placed(path: string): string {
    let real: string = sep;
    for (const part of resolve(path).split(sep)) {
      if (part === "") continue;
      const lexical = join(real, part);
      const target = trackedRealpath(lexical) ?? lexical;
      if (target !== lexical) this.links.set(lexical, target);
      real = target;
    }
    return real;
  }

  /** The real path of the file an absolute or relative `specifier` names
   * from `fromFile`, or null when there is none. */
  resolvedPath(fromFile: string, specifier: string): string | null {
    if (!isPathSpecifier(specifier)) return null;
    const target = resolveFile(resolve(dirname(fromFile), specifier));
    return target === null ? null : (trackedRealpath(target) ?? target);
  }

  /** A specifier that names `target` from `caller` inside the tree: the
   * relative path between them, with `/` separators. */
  static relativeSpecifier(caller: string, target: string): string {
    const path = portable(relative(dirname(caller), target));
    return path.startsWith("../") ? path : `./${path}`;
  }

  /** A module of the program: collected with the package.json that scopes
   * it (Node reads its "type"), and its imports traced. */
  private addModule(file: string): string | null {
    if (this.traced.has(file)) return null;
    this.traced.add(file);
    this.files.add(file);
    // The program provides its source: island code never runs this file,
    // so what it imports is not shipped for it.
    if (this.provided.has(file)) return null;
    const scope = packageScope(dirname(file));
    if (scope !== null) this.files.add(scope);
    if (!TRACED.test(file)) return null;
    const text = trackedReadFile(file);
    if (text === null) return `cannot read ${file}`;
    const dataProblem = this.addNamedData(file, text);
    if (dataProblem !== null) return dataProblem;
    const scan = scanModuleSpecifiers(text);
    if (scan.computed.length > 0) {
      const first = scan.computed[0]!;
      const line = text.slice(0, first.at).split("\n").length;
      return `${file}:${line} loads a module through ${first.form}; a module that runs in a Node island loads modules by string-literal specifiers only`;
    }
    for (const specifier of scan.specifiers) {
      const problem = this.resolveFrom(file, specifier);
      if (problem !== null) return problem;
    }
    return null;
  }

  /** Data files beside a program module that runs in an island: the module
   * resolves them from its own directory (photon redirects a package's
   * read to the wasm next to the patching module), and the island runs from
   * the shipped tree, so a file the module names by its path relative to
   * the module's directory ships with it (namedDataPaths). Only the exact
   * path ships, and module sources ship through the traced walk, never as
   * data. A named path stays inside the module's directory: one that leads
   * outside it, through `..` or a symbolic link, or into node_modules or
   * .git, is not shipped, so nothing from elsewhere on the machine is
   * embedded.
   *
   * Returns the reason the build cannot ship the module when it names a
   * file by a path where there is none while a file of that name is inside
   * its directory: the island would read a file the build left out. */
  private addNamedData(moduleFile: string, text: string): string | null {
    const root = dirname(moduleFile);
    const inside = (path: string): boolean => {
      const rel = relative(root, path);
      return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    };
    const unresolved: { name: string; at: number }[] = [];
    /** The names of the files this module's named paths ship. */
    const shippedNames = new Set<string>();
    for (const [name, at] of namedDataPaths(text)) {
      if (isAbsolute(name) || name.includes("\0")) continue;
      const path = resolve(root, name);
      if (!inside(path) || path === moduleFile || TRACED.test(path)) continue;
      const parts = relative(root, path).split(sep);
      if (parts.includes("node_modules") || parts.includes(".git")) continue;
      if (!trackedFileExists(path)) {
        if (basename(name).includes(".")) unresolved.push({ name, at });
        continue;
      }
      const target = trackedRealpath(path);
      if (target === null || !inside(target)) continue;
      // A link inside the directory stays a link in the tree (placed).
      this.files.add(this.placed(path));
      shippedNames.add(basename(path));
    }
    if (unresolved.length === 0) return null;
    // The files of the module's directory by name, links leading outside it
    // not followed.
    const byName = new Map<string, string>();
    const visited = new Set<string>();
    const walk = (dir: string): void => {
      const real = trackedRealpath(dir);
      if (real === null || (real !== root && !inside(real)) || visited.has(real)) return;
      visited.add(real);
      const entries = trackedAccessibleEntries(dir);
      if (entries === null) return;
      for (const file of entries.files) {
        const path = join(dir, file);
        if (byName.has(file) || TRACED.test(file) || path === moduleFile) continue;
        const target = trackedRealpath(path);
        if (target !== null && inside(target)) byName.set(file, path);
      }
      for (const sub of entries.directories)
        if (sub !== "node_modules" && sub !== ".git") walk(join(dir, sub));
    };
    walk(root);
    for (const { name, at } of unresolved) {
      // A name of a file another named path ships (`"payload.txt"` beside
      // `join(here, "fallback", "payload.txt")`) is not missing, wherever
      // other files of that name are.
      if (shippedNames.has(basename(name))) continue;
      const found = byName.get(basename(name));
      if (found === undefined || this.files.has(trackedRealpath(found) ?? found)) continue;
      const line = text.slice(0, at).split("\n").length;
      const there = portable(relative(root, found));
      const problem = `${moduleFile}:${line} names the file '${name}', which is not at that path beside the module; the build ships a module's data files by their exact path, so '${there}' does not ship with the Node island. Name the file by its path relative to the module ('${there}')`;
      this.dataProblems.add(problem);
      return problem;
    }
    return null;
  }

  /** A package: its whole directory, then its dependencies. */
  private addPackage(found: string): void {
    const dir = this.placed(found);
    if (this.packages.has(dir)) return;
    this.packages.add(dir);
    const scripts: string[] = [];
    this.addDirectory(dir, new Set(), scripts);
    // A package may load another it does not declare (one installed beside
    // it): Node finds that one by walking up node_modules, and so does the
    // build, from each string-literal specifier of the package's JavaScript.
    for (const file of scripts) {
      const text = trackedReadFile(file);
      if (text === null) continue;
      for (const specifier of scanModuleSpecifiers(text).specifiers) {
        if (isBuiltin(specifier) || isPathSpecifier(specifier)) continue;
        if (specifier.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) continue;
        const other = packageDirectory(dirname(file), packageName(specifier));
        if (other !== null) this.addPackage(other);
      }
    }
    const manifest = trackedReadFile(join(dir, "package.json"));
    if (manifest === null) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(manifest) as Record<string, unknown>;
    } catch {
      return;
    }
    const names = new Set<string>();
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const deps = parsed[field];
      if (deps !== null && typeof deps === "object")
        for (const name of Object.keys(deps)) names.add(name);
    }
    // A package import ("imports") may map to another package.
    for (const target of importTargets(parsed["imports"]))
      if (!isPathSpecifier(target) && !isBuiltin(target)) names.add(packageName(target));
    for (const name of [...names].sort()) {
      // A dependency that is not installed (optional, or a peer the program
      // does not use) is not loaded either.
      const depDir = packageDirectory(dir, name);
      if (depDir !== null) this.addPackage(depDir);
    }
  }

  /** Every file below `dir`, except nested node_modules (dependencies come
   * through package.json and the package's imports) and .git; the
   * JavaScript files among them also go to `scripts`. */
  private addDirectory(dir: string, visited: Set<string>, scripts: string[]): void {
    const real = trackedRealpath(dir) ?? dir;
    if (visited.has(real)) return;
    visited.add(real);
    const entries = trackedAccessibleEntries(dir);
    if (entries === null) return;
    for (const file of entries.files) {
      this.files.add(join(dir, file));
      if (SCRIPT.test(file)) scripts.push(join(dir, file));
    }
    for (const sub of entries.directories) {
      if (sub === "node_modules" || sub === ".git") continue;
      this.addDirectory(join(dir, sub), visited, scripts);
    }
  }
}

/* ── module specifiers in JavaScript source ───────────────────────────── */

interface Token {
  kind: "name" | "string" | "punct" | "other";
  value: string;
  at: number;
}

/** Keywords after which a `/` starts a regular expression. */
const REGEX_AFTER = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

function isNameStart(c: string): boolean {
  return /[A-Za-z_$\u0080-￿]/.test(c);
}

function isNamePart(c: string): boolean {
  return /[A-Za-z0-9_$\u0080-￿]/.test(c);
}

/** The significant tokens of a JavaScript or TypeScript source: names,
 * string literals (cooked) and punctuators, without comments, template
 * text or regular expressions. */
export function moduleTokens(text: string): Token[] {
  const tokens: Token[] = [];
  /** Brace depths at which a template literal's `${` was opened. */
  const templates: number[] = [];
  let depth = 0;
  let i = 0;
  const n = text.length;
  const regexAllowed = (): boolean => {
    const last = tokens[tokens.length - 1];
    if (last === undefined) return true;
    if (last.kind === "name") return REGEX_AFTER.has(last.value);
    if (last.kind === "punct")
      return last.value !== ")" && last.value !== "]" && last.value !== "}";
    return false;
  };
  const template = (start: number): void => {
    // From just after a backtick or a closing `}` to the end of the
    // template or the next `${`.
    while (i < n) {
      const c = text[i]!;
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        i++;
        tokens.push({ kind: "other", value: "`", at: start });
        return;
      }
      if (c === "$" && text[i + 1] === "{") {
        i += 2;
        templates.push(depth);
        depth++;
        tokens.push({ kind: "punct", value: "${", at: start });
        return;
      }
      i++;
    }
  };
  while (i < n) {
    const c = text[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === "#" && i === 0 && text[1] === "!") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i;
      let value = "";
      i++;
      while (i < n && text[i] !== c && text[i] !== "\n") {
        if (text[i] === "\\") {
          const e = text[i + 1] ?? "";
          value += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "\n" ? "" : e;
          i += 2;
          continue;
        }
        value += text[i];
        i++;
      }
      i++;
      tokens.push({ kind: "string", value, at: start });
      continue;
    }
    if (c === "`") {
      const start = i;
      i++;
      template(start);
      continue;
    }
    if (c === "/" && regexAllowed()) {
      const start = i;
      i++;
      let inClass = false;
      while (i < n && text[i] !== "\n") {
        const r = text[i]!;
        if (r === "\\") {
          i += 2;
          continue;
        }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        i++;
      }
      i++;
      while (i < n && isNamePart(text[i]!)) i++;
      tokens.push({ kind: "other", value: "/re/", at: start });
      continue;
    }
    if (isNameStart(c)) {
      const start = i;
      while (i < n && isNamePart(text[i]!)) i++;
      tokens.push({ kind: "name", value: text.slice(start, i), at: start });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      const start = i;
      while (i < n && /[0-9A-Za-z_.]/.test(text[i]!)) i++;
      tokens.push({ kind: "other", value: text.slice(start, i), at: start });
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      if (templates.length > 0 && templates[templates.length - 1] === depth - 1) {
        templates.pop();
        depth--;
        const start = i;
        i++;
        tokens.push({ kind: "punct", value: "}", at: start });
        template(start);
        continue;
      }
      depth--;
    }
    if (c === "." && text[i + 1] === "." && text[i + 2] === ".") {
      tokens.push({ kind: "punct", value: "...", at: i });
      i += 3;
      continue;
    }
    if (c === "?" && text[i + 1] === ".") {
      tokens.push({ kind: "punct", value: "?.", at: i });
      i += 2;
      continue;
    }
    tokens.push({ kind: "punct", value: c, at: i });
    i++;
  }
  return tokens;
}

export interface ModuleSpecifierScan {
  /** String-literal specifiers of require(), require.resolve(), import(),
   * import.meta.resolve() and import/export declarations, in source order. */
  specifiers: string[];
  /** Loads whose module the source does not name with a string literal. */
  computed: { at: number; form: string }[];
}

/** The relative paths a module's source names by string literals, with the
 * offset of the first literal that names each: each
 * literal (`"data/table.json"`), and the literals passed as consecutive
 * arguments of one call joined with `/`, as `path.join(here, "fallback",
 * "payload.txt")` names `fallback/payload.txt`. Comments and template
 * literals with substitutions name nothing; `__dirname + "/data.json"` names
 * `data.json`. */
export function namedDataPaths(text: string): Map<string, number> {
  const tokens = moduleTokens(text);
  const names = new Map<string, number>();
  const add = (name: string, at: number): void => {
    if (!names.has(name)) names.set(name, at);
  };
  /** The open brackets around the current token. */
  const open: string[] = [];
  let run: Token[] = [];
  const end = (): void => {
    if (run.length > 1) add(run.map((t) => t.value).join("/"), run[0]!.at);
    run = [];
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind === "string") {
      if (t.value.includes("${")) {
        end();
        continue;
      }
      add(t.value, t.at);
      const before = tokens[k - 1];
      const after = tokens[k + 1];
      // `__dirname + "/data.json"` names data.json beside the module.
      if (before?.kind === "punct" && before.value === "+" && t.value.startsWith("/"))
        add(t.value.slice(1), t.at);
      const argument =
        open[open.length - 1] === "(" &&
        before?.kind === "punct" &&
        (before.value === "(" || before.value === ",") &&
        after?.kind === "punct" &&
        (after.value === ")" || after.value === ",");
      if (!argument) end();
      else run.push(t);
      continue;
    }
    if (t.kind === "punct") {
      if (t.value === "(" || t.value === "[" || t.value === "{") open.push(t.value);
      else if (t.value === ")" || t.value === "]" || t.value === "}") open.pop();
    }
    if (t.kind !== "punct" || t.value !== ",") end();
  }
  end();
  return names;
}

/** The string-literal arguments of `requireModule(...)` calls in source
 * code, comments and template text excluded. */
export function requireModuleSpecifiers(text: string): string[] {
  const tokens = moduleTokens(text);
  const out: string[] = [];
  for (let k = 0; k + 3 < tokens.length; k++) {
    const [name, open, arg, close] = [tokens[k]!, tokens[k + 1]!, tokens[k + 2]!, tokens[k + 3]!];
    if (
      name.kind === "name" &&
      name.value === "requireModule" &&
      open.kind === "punct" &&
      open.value === "(" &&
      arg.kind === "string" &&
      close.kind === "punct" &&
      close.value === ")"
    )
      out.push(arg.value);
  }
  return out;
}

export function scanModuleSpecifiers(text: string): ModuleSpecifierScan {
  const tokens = moduleTokens(text);
  const specifiers: string[] = [];
  const computed: { at: number; form: string }[] = [];
  const at = (k: number): Token | undefined => tokens[k];
  const is = (k: number, kind: Token["kind"], value?: string): boolean => {
    const t = tokens[k];
    return t !== undefined && t.kind === kind && (value === undefined || t.value === value);
  };
  /** A call `(` at k whose single argument is a string literal. */
  const literalCall = (k: number): string | null =>
    is(k, "punct", "(") &&
    is(k + 1, "string") &&
    (is(k + 2, "punct", ")") || is(k + 2, "punct", ","))
      ? at(k + 1)!.value
      : null;
  // `const r = createRequire(...)` declares a require function of the
  // module: calls of `r` load modules as require() calls do.
  const aliases = new Set<string>();
  const declarations = new Set<number>();
  for (let k = 0; k + 4 < tokens.length; k++) {
    if (
      (is(k, "name", "const") || is(k, "name", "let") || is(k, "name", "var")) &&
      is(k + 1, "name") &&
      is(k + 2, "punct", "=") &&
      is(k + 3, "name", "createRequire") &&
      is(k + 4, "punct", "(")
    ) {
      aliases.add(at(k + 1)!.value);
      declarations.add(k + 1).add(k + 3);
    }
  }
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind !== "name" || declarations.has(k)) continue;
    const member = is(k - 1, "punct", ".") || is(k - 1, "punct", "?.");
    if ((t.value === "require" || aliases.has(t.value)) && !member && !is(k + 1, "punct", ":")) {
      if (is(k - 1, "name", "function") || is(k - 1, "name", "typeof")) continue;
      let call = k + 1;
      let form = "require()";
      if (is(k + 1, "punct", ".") && is(k + 2, "name", "resolve")) {
        call = k + 3;
        form = "require.resolve()";
      } else if (is(k + 1, "punct", ".")) {
        continue;
      }
      if (!is(call, "punct", "(")) {
        computed.push({ at: t.at, form: "require as a value" });
        continue;
      }
      const literal = literalCall(call);
      if (literal === null) computed.push({ at: t.at, form: `${form} with a computed specifier` });
      else specifiers.push(literal);
      continue;
    }
    if (t.value === "createRequire" && !member && is(k + 1, "punct", "(")) {
      computed.push({ at: t.at, form: "a require() from createRequire()" });
      continue;
    }
    if (t.value === "import" && !member) {
      if (is(k + 1, "punct", ".")) {
        // import.meta.resolve() names a module, as require.resolve() does.
        if (is(k + 2, "name", "meta") && is(k + 3, "punct", ".") && is(k + 4, "name", "resolve")) {
          const literal = literalCall(k + 5);
          if (literal !== null) specifiers.push(literal);
          else if (is(k + 5, "punct", "("))
            computed.push({ at: t.at, form: "import.meta.resolve() with a computed specifier" });
        }
        continue;
      }
      if (is(k + 1, "punct", "(")) {
        const literal = literalCall(k + 1);
        if (literal === null)
          computed.push({ at: t.at, form: "import() with a computed specifier" });
        else specifiers.push(literal);
        continue;
      }
      if (is(k + 1, "string")) {
        specifiers.push(at(k + 1)!.value);
        continue;
      }
      for (let j = k + 1; j < tokens.length && j < k + 400; j++) {
        if (is(j, "punct", ";")) break;
        if (is(j, "name", "from") && is(j + 1, "string")) {
          specifiers.push(at(j + 1)!.value);
          break;
        }
      }
      continue;
    }
    if (t.value === "export" && !member) {
      let j = k + 1;
      if (is(j, "name", "type")) j++;
      if (is(j, "punct", "*")) {
        for (; j < tokens.length && j < k + 400; j++) {
          if (is(j, "punct", ";")) break;
          if (is(j, "name", "from") && is(j + 1, "string")) {
            specifiers.push(at(j + 1)!.value);
            break;
          }
        }
      } else if (is(j, "punct", "{")) {
        while (j < tokens.length && !is(j, "punct", "}")) j++;
        if (is(j + 1, "name", "from") && is(j + 2, "string")) specifiers.push(at(j + 2)!.value);
      }
    }
  }
  return { specifiers, computed };
}

/* ── shipping the tree ────────────────────────────────────────────────── */

/** What the tree ships at the path of a program module the islands share:
 * Node resolves the module to this file and the program's loader hooks
 * answer its source (runtime scr_node_island_hooks.cjs), so the file holds
 * none of the program's source. Evaluating it throws. */
export function providedModulePlaceholder(path: string): Uint8Array {
  return new TextEncoder().encode(
    `throw new Error(${JSON.stringify(`${path} is provided by the compiled program`)});\n`,
  );
}

/** The manifest the executable records (scr_node_island.c reads it):
 * `{"files":[[path,size,sha256],...],"links":[[path,target],...]}`. Its
 * SHA-256 names the tree. */
export function nodeIslandManifest(modules: IrNodeIslandModules): string {
  return JSON.stringify({
    files: modules.files.map((file) => [file.path, file.size, file.sha256]),
    links: modules.links.map((link) => [link.path, link.target]),
  });
}

/** The tree's files concatenated in manifest order, each checked against
 * the digest the build recorded, or the reason one no longer matches. */
export function readNodeIslandModules(modules: IrNodeIslandModules): Uint8Array | string {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const file of modules.files) {
    const path = join(modules.root, ...file.path.split("/"));
    let bytes: Uint8Array;
    if (file.placeholder === true) bytes = providedModulePlaceholder(file.path);
    else
      try {
        bytes = new Uint8Array(readFileSync(path));
      } catch {
        return `${path} was removed during the build`;
      }
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
      return `${path} changed during the build`;
    parts.push(bytes);
    total += bytes.length;
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return data;
}

/** Writes the tree to `target` (replacing it), for `--libnode=beside`, or
 * returns the reason it cannot. */
export function placeNodeIslandModules(
  modules: IrNodeIslandModules,
  target: string,
): string | null {
  const data = readNodeIslandModules(modules);
  if (typeof data === "string") return data;
  // Every path, and every link's target, stays inside the tree.
  const inside = resolve(target) + sep;
  const placed = (relativePath: string): string | null => {
    const path = resolve(target, ...relativePath.split("/"));
    return path.startsWith(inside) ? path : null;
  };
  for (const entry of [...modules.files, ...modules.links]) {
    const path = placed(entry.path);
    if (path === null) return `the island module tree names a path outside it ('${entry.path}')`;
    if ("target" in entry && !resolve(dirname(path), entry.target).startsWith(inside))
      return `the island module tree links outside it ('${entry.path}' to '${entry.target}')`;
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  let offset = 0;
  for (const file of modules.files) {
    const path = placed(file.path)!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data.subarray(offset, offset + file.size), { flag: "wx" });
    offset += file.size;
  }
  for (const link of modules.links) {
    const path = placed(link.path)!;
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(link.target, path);
  }
  return null;
}
