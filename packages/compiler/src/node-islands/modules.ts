/* The island module tree: the JavaScript a program's Node island calls load,
 * collected at build time and shipped with the executable, so a deployed
 * binary never reads modules from the machine that built it.
 *
 * Each `call`/`callSync` names its module with a string literal. The build
 * resolves it from the calling module as Node's require() does:
 * - a relative or absolute specifier names a module of the program: the
 *   module and every module its string-literal `require()`, `import` and
 *   `export ... from` reach are collected; a computed specifier in such a
 *   module is refused, since the build cannot know what it loads;
 * - a package specifier names a package: its whole directory is collected
 *   (computed requires inside packages keep working), and so are its
 *   `dependencies`, `optionalDependencies` and `peerDependencies`, found as
 *   Node finds them;
 * - a Node built-in module needs nothing, and neither does a module the
 *   build cannot find: loading it throws MODULE_NOT_FOUND when the call
 *   runs, as under Node.
 * Paths keep their layout relative to one root directory (the deepest
 * directory that holds every collected path), with symbolic links between
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

export type NodeIslandModuleTree = IrNodeIslandModules;
type NodeIslandModuleFile = IrNodeIslandModules["files"][number];
type NodeIslandModuleLink = IrNodeIslandModules["links"][number];

const BUILTINS: ReadonlySet<string> = new Set(builtinModules);

/** Extensions require() tries for an extensionless file, in its order. */
const FILE_EXTENSIONS = [".js", ".json", ".node"];

/** Module files whose imports are traced. */
const TRACED = /\.(?:[cm]?js|[cm]?ts)$/;

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

  /** Collects the module `specifier` names from `caller` (a real path).
   * Returns null, or the reason the build cannot ship it. */
  add(caller: string, specifier: string): string | null {
    this.callers.add(caller);
    return this.resolveFrom(caller, specifier);
  }

  /** The collected tree, or null when no call loads a file. */
  tree(): NodeIslandModuleTree | null {
    if (this.files.size === 0 && this.links.size === 0) return null;
    const anchors = [
      ...this.files,
      ...this.links.keys(),
      ...this.links.values(),
      ...[...this.callers].map((caller) => dirname(caller)),
    ];
    const root = commonDirectory(anchors);
    const files: NodeIslandModuleFile[] = [];
    for (const file of [...this.files].sort()) {
      const bytes = trackedReadBytes(file);
      if (bytes === null) continue;
      files.push({
        path: portable(relative(root, file)),
        size: bytes.length,
        sha256: sha256(bytes),
      });
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
    const scope = packageScope(dirname(file));
    if (scope !== null) this.files.add(scope);
    if (!TRACED.test(file)) return null;
    const text = trackedReadFile(file);
    if (text === null) return `cannot read ${file}`;
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

  /** A package: its whole directory, then its dependencies. */
  private addPackage(found: string): void {
    const dir = this.placed(found);
    if (this.packages.has(dir)) return;
    this.packages.add(dir);
    this.addDirectory(dir, new Set());
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
    for (const name of [...names].sort()) {
      // A dependency that is not installed (optional, or a peer the program
      // does not use) is not loaded either.
      const depDir = packageDirectory(dir, name);
      if (depDir !== null) this.addPackage(depDir);
    }
  }

  /** Every file below `dir`, except nested node_modules (dependencies come
   * through package.json) and .git. */
  private addDirectory(dir: string, visited: Set<string>): void {
    const real = trackedRealpath(dir) ?? dir;
    if (visited.has(real)) return;
    visited.add(real);
    const entries = trackedAccessibleEntries(dir);
    if (entries === null) return;
    for (const file of entries.files) this.files.add(join(dir, file));
    for (const sub of entries.directories) {
      if (sub === "node_modules" || sub === ".git") continue;
      this.addDirectory(join(dir, sub), visited);
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
  /** String-literal specifiers of require(), require.resolve(), import()
   * and import/export declarations, in source order. */
  specifiers: string[];
  /** Loads whose module the source does not name with a string literal. */
  computed: { at: number; form: string }[];
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
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind !== "name") continue;
    const member = is(k - 1, "punct", ".") || is(k - 1, "punct", "?.");
    if (t.value === "require" && !member && !is(k + 1, "punct", ":")) {
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
      if (is(k + 1, "punct", ".")) continue; // import.meta
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
