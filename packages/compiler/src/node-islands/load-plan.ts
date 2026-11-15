/* The island load plan: what Node's module resolver answers for the shipped
 * module tree, computed when the program is built.
 *
 * Node resolves every `import` and `require` of island code when the program
 * starts: URL objects, `stat`, `realpath`, the package scope, for each of a
 * package's files, on every start. The answers are a function of the tree,
 * and the tree ships with the program (modules.ts) and is checked against
 * its manifest before Node starts (runtime scr_node_island.c). So the build
 * computes them once and ships them as one more file of the tree,
 * `.scriptc/load-plan`. The island bootstrap's loader hooks answer from it
 * and leave every other request to Node (runtime scr_node_island_host.cjs).
 * Each file stays a file: V8 compiles it under its own name and links the
 * module graph itself, so source positions, cycles, live bindings and
 * namespace objects are Node's own.
 *
 * The plan holds only answers that are a short closed rule over the tree
 * (the rules of Node 24's `Module._findPath` and `finalizeResolution`):
 *
 * - a relative specifier (`.`, `..`, `./x`, `../x`) written with plain
 *   characters, from a module file of the tree: for `require`, the file
 *   itself, then `.js`, `.json`, `.node`, then a directory's `index`; for
 *   `import`, the file itself when it is an ES module by its name or by
 *   the `package.json` that scopes it inside the tree;
 * - which files are module files, so the bootstrap can answer a load of one
 *   by its absolute path.
 *
 * Everything else is Node's as before: package names (`exports`, `imports`,
 * conditions, `main`), built-ins, URLs, a directory whose `package.json`
 * names a `main` (its missing-file error and deprecation warning are
 * Node's), a `.js` file whose format Node detects from its syntax, a
 * CommonJS module imported from ES code (Node hands a module a hook
 * resolved to its CommonJS loader by another path than one it resolved
 * itself), and any path with a character `pathToFileURL` escapes. A module that uses
 * `require` other than by calling it gets no `require` answers:
 * `require.resolve(request, { paths })` resolves a relative request against
 * `paths`, which a loader hook cannot see.
 *
 * SCRIPTC_NODE_ISLANDS_TRACE=plan at build time prints, per package, how
 * many relative requests the plan answers and how many it leaves to Node,
 * by reason. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IrNodeIslandModules } from "../ir/ir.js";
import { moduleTokens, scanModuleSpecifiers } from "./modules.js";

/** The plan's path in the tree. */
export const LOAD_PLAN_PATH = ".scriptc/load-plan";

/** Characters a tree path may have for the plan to name it: the ones
 * `pathToFileURL` neither escapes nor rewrites, so the bootstrap forms a
 * module's URL by appending the path to the tree root's URL. */
const PLAIN_PATH = /^[A-Za-z0-9._\-/@+~=,]+$/;

/** Files whose loads the plan answers: JavaScript and TypeScript modules,
 * not declaration files. */
const MODULE_FILE = /\.(?:[cm]?js|[cm]?ts)$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;

/** A quote followed by `./`, `../`, `.` or `..`: where a string literal
 * that is a relative specifier starts. */
const RELATIVE_LITERAL = /['"]\.(?:\/|\.\/|\.?['"])/;

/** The extensions `require` tries, in `Module._extensions` order. */
const REQUIRE_EXTENSIONS = [".js", ".json", ".node"];

/** A relative specifier under both loaders (`isRelative` in Node's CommonJS
 * loader, `isRelativeSpecifier` in its ES module resolver). */
function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  );
}

/** Whether a request names a directory by its form: it ends in `/`, or its
 * last segment is `.` or `..` (the `trailingSlash` of `Module._findPath`). */
function namesDirectory(request: string): boolean {
  return /(?:^|\/)\.{0,2}$/.test(request);
}

/** The shipped tree as Node sees it once it is extracted: regular files,
 * links and directories, by path relative to the root (`""` is the root). */
export class IslandTreeModel {
  private readonly files = new Set<string>();
  private readonly links = new Map<string, string | null>();
  private readonly directories = new Set<string>([""]);

  constructor(tree: Pick<IrNodeIslandModules, "files" | "links">) {
    for (const file of tree.files) {
      this.files.add(file.path);
      this.addDirectories(file.path);
    }
    for (const link of tree.links) {
      // A link's target is relative to the link's directory.
      this.links.set(link.path, IslandTreeModel.join(dirnameOf(link.path), link.target));
      this.addDirectories(link.path);
    }
  }

  private addDirectories(path: string): void {
    for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
      const directory = path.slice(0, at);
      if (this.directories.has(directory)) break;
      this.directories.add(directory);
    }
  }

  /** `path.resolve(directory, request)` inside the tree, or null when the
   * result is outside it. */
  static join(directory: string, request: string): string | null {
    const parts = directory === "" ? [] : directory.split("/");
    for (const part of request.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (parts.length === 0) return null;
        parts.pop();
      } else parts.push(part);
    }
    return parts.join("/");
  }

  /** The path with every link on it followed, as `realpath` answers on the
   * extracted tree, or null when a link leads outside the tree. */
  realpath(path: string): string | null {
    let parts = path === "" ? [] : path.split("/");
    let real = "";
    let hops = 0;
    for (let i = 0; i < parts.length; i++) {
      const next = real === "" ? parts[i]! : `${real}/${parts[i]}`;
      if (this.links.has(next)) {
        const target = this.links.get(next)!;
        if (target === null || ++hops > 40) return null;
        parts = [...(target === "" ? [] : target.split("/")), ...parts.slice(i + 1)];
        real = "";
        i = -1;
        continue;
      }
      real = next;
    }
    return real;
  }

  /** What `stat` finds at `path` (links followed): a regular file, a
   * directory, nothing, or `unknown` when the path leaves the tree. */
  stat(path: string | null): "file" | "directory" | "none" | "unknown" {
    if (path === null) return "unknown";
    const real = this.realpath(path);
    if (real === null) return "unknown";
    if (this.files.has(real)) return "file";
    if (this.directories.has(real)) return "directory";
    return "none";
  }
}

function dirnameOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

/** The directory of the package that holds `path`: the path up to the last
 * `node_modules/<name>` (or `node_modules/@scope/<name>`) directory above
 * the file; `""` for a file of the program. The plan keeps one document
 * per such directory, read when a module of it first asks. */
export function planGroupOf(path: string): string {
  const parts = path.split("/");
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] !== "node_modules") continue;
    const scoped = parts[i + 1]!.startsWith("@") ? 2 : 1;
    // The file is inside the package directory, not the directory itself.
    if (i + scoped < parts.length - 1) return parts.slice(0, i + 1 + scoped).join("/");
  }
  return "";
}

/** Why the plan leaves a relative request to Node. (A package name, a
 * built-in, an absolute path and a URL are always Node's.) */
export type PlanLeft =
  | "a specifier with characters outside the plain set"
  | "no such file in the shipped tree"
  | "a directory whose package.json names a main"
  | "a module whose format Node detects when it loads"
  | "a CommonJS module imported from ES code"
  | "the module uses require other than by calling it"
  | "a path that leaves the shipped tree";

export interface PlanGroupReport {
  directory: string;
  files: number;
  /** Relative specifiers the plan answers under at least one loader. */
  answered: number;
  /** Relative specifiers it leaves to Node under both loaders, by reason. */
  left: Map<PlanLeft, number>;
}

export interface LoadPlan {
  /** The file's bytes: a header line, then one document per group. */
  bytes: Uint8Array;
  groups: PlanGroupReport[];
}

/** The `type` a `package.json` declares, `none` when it declares none, or
 * null when Node would refuse the file (the request is Node's then). */
function declaredType(text: string): "module" | "commonjs" | "none" | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const type = (parsed as { type?: unknown }).type;
  return type === "module" || type === "commonjs" ? type : "none";
}

/** Whether a `package.json` has a `main` (any value: Node's `main` rules
 * decide then), or cannot be read as an object. */
function namesMain(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return true;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return true;
  return Object.hasOwn(parsed, "main");
}

/** Whether a module's source uses `require` other than by calling it or
 * testing for it (`require.resolve`, an alias, `createRequire`): the
 * requests such a module makes can carry options a hook does not see. */
export function usesRequireIndirectly(tokens: ReturnType<typeof moduleTokens>): boolean {
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind !== "name") continue;
    if (t.value === "createRequire") return true;
    if (t.value !== "require") continue;
    const before = tokens[k - 1];
    const after = tokens[k + 1];
    // A member named `require` (`module.require(x)` takes no options).
    if (before?.kind === "punct" && (before.value === "." || before.value === "?.")) continue;
    if (before?.kind === "name" && (before.value === "typeof" || before.value === "function"))
      continue;
    if (after?.kind === "punct" && after.value === "(") continue;
    // A property key (`{ require: ... }`).
    if (after?.kind === "punct" && after.value === ":") continue;
    if (after?.kind === "punct" && after.value === ".") {
      const member = tokens[k + 2];
      if (member?.kind === "name" && (member.value === "main" || member.value === "cache"))
        continue;
    }
    return true;
  }
  return false;
}

class PlanBuilder {
  private readonly typeOfPackageJson = new Map<string, "module" | "commonjs" | "none" | null>();
  private readonly mainOfPackageJson = new Map<string, boolean>();

  constructor(
    private readonly model: IslandTreeModel,
    private readonly read: (path: string) => string | null,
  ) {}

  /** What `require(request)` loads from a module in `directory`: the real
   * path of a file, or the reason the request is left to Node. */
  require(directory: string, request: string): { path: string } | PlanLeft {
    const base = IslandTreeModel.join(directory, request);
    if (base === null) return "a path that leaves the shipped tree";
    const found = this.model.stat(base);
    if (found === "unknown") return "a path that leaves the shipped tree";
    const real = (path: string): { path: string } | PlanLeft => {
      const at = this.model.realpath(path);
      return at === null ? "a path that leaves the shipped tree" : { path: at };
    };
    if (!namesDirectory(request)) {
      if (found === "file") return real(base);
      // The root has no file name to add an extension to.
      if (base !== "")
        for (const extension of REQUIRE_EXTENSIONS) {
          const candidate = this.model.stat(base + extension);
          if (candidate === "unknown") return "a path that leaves the shipped tree";
          if (candidate === "file") return real(base + extension);
        }
    }
    if (found !== "directory") return "no such file in the shipped tree";
    const manifest = base === "" ? "package.json" : `${base}/package.json`;
    const hasManifest = this.model.stat(manifest);
    if (hasManifest === "unknown") return "a path that leaves the shipped tree";
    if (hasManifest === "file") {
      const path = this.model.realpath(manifest)!;
      let main = this.mainOfPackageJson.get(path);
      if (main === undefined) {
        const text = this.read(path);
        main = text === null || namesMain(text);
        this.mainOfPackageJson.set(path, main);
      }
      if (main) return "a directory whose package.json names a main";
    }
    for (const extension of REQUIRE_EXTENSIONS) {
      const index = `${base === "" ? "" : `${base}/`}index${extension}`;
      const candidate = this.model.stat(index);
      if (candidate === "unknown") return "a path that leaves the shipped tree";
      if (candidate === "file") return real(index);
    }
    return "no such file in the shipped tree";
  }

  /** What `import specifier` loads from a module in `directory`: the real
   * path of an ES module, or the reason the request is Node's. */
  import(directory: string, specifier: string): { path: string } | PlanLeft {
    // A directory is an error under the ES module resolver: Node reports it.
    if (namesDirectory(specifier)) return "no such file in the shipped tree";
    const base = IslandTreeModel.join(directory, specifier);
    if (base === null) return "a path that leaves the shipped tree";
    const found = this.model.stat(base);
    if (found === "unknown") return "a path that leaves the shipped tree";
    if (found !== "file") return "no such file in the shipped tree";
    const path = this.model.realpath(base);
    if (path === null) return "a path that leaves the shipped tree";
    const format = this.importFormat(path);
    if (format === null) return "a module whose format Node detects when it loads";
    if (format === "commonjs") return "a CommonJS module imported from ES code";
    return { path };
  }

  /** The format Node's resolver states for the file at a real path, when
   * its name or a `package.json` of the tree decides it. */
  importFormat(path: string): "module" | "commonjs" | null {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    // A name that is only an extension has none (Node's `extname`).
    const extension = dot <= 0 ? "" : name.slice(dot);
    if (extension === ".mjs") return "module";
    if (extension === ".cjs") return "commonjs";
    if (extension !== ".js") return null;
    // The package scope: the nearest package.json above the file, not
    // looking inside a directory named node_modules, and not above the
    // tree (what is there is the machine's, not the program's).
    for (let directory = dirnameOf(path); ; directory = dirnameOf(directory)) {
      if (directory === "node_modules" || directory.endsWith("/node_modules")) return null;
      const manifest = directory === "" ? "package.json" : `${directory}/package.json`;
      const found = this.model.stat(manifest);
      if (found === "unknown") return null;
      if (found === "file") {
        const real = this.model.realpath(manifest)!;
        let type = this.typeOfPackageJson.get(real);
        if (type === undefined) {
          const text = this.read(real);
          type = text === null ? null : declaredType(text);
          this.typeOfPackageJson.set(real, type);
        }
        return type === "module" || type === "commonjs" ? type : null;
      }
      if (directory === "") return null;
    }
  }
}

interface GroupDocument {
  /** Module files of the group, by path below its directory. */
  files: string[];
  /** Targets outside `files`, by path in the tree; a target's id is its
   * index in `files`, or `files.length` plus its index here. */
  extern: string[];
  /** Per file: `specifier, require target id, import target id` triples;
   * -1 where the request is Node's. An import target is an ES module. */
  requests: (string | number)[][];
}

/** The load plan of a tree, or null when it has no module file the plan can
 * name. `read` answers a tree file's text by its path in the tree (null
 * when it cannot be read: the build fails on that file elsewhere). */
export function buildLoadPlan(
  tree: Pick<IrNodeIslandModules, "files" | "links">,
  read: (path: string) => string | null,
): LoadPlan | null {
  const model = new IslandTreeModel(tree);
  const builder = new PlanBuilder(model, read);
  const grouped = new Map<string, string[]>();
  for (const file of tree.files) {
    // A program module the islands share is answered by its own hooks.
    if (file.placeholder === true || !MODULE_FILE.test(file.path)) continue;
    if (DECLARATION_FILE.test(file.path)) continue;
    if (!PLAIN_PATH.test(file.path)) continue;
    const group = planGroupOf(file.path);
    const list = grouped.get(group);
    if (list === undefined) grouped.set(group, [file.path]);
    else list.push(file.path);
  }
  if (grouped.size === 0) return null;
  const documents: { directory: string; text: string }[] = [];
  const reports: PlanGroupReport[] = [];
  for (const directory of [...grouped.keys()].sort()) {
    const paths = grouped.get(directory)!.sort();
    const prefix = directory === "" ? "" : `${directory}/`;
    const ids = new Map<string, number>();
    paths.forEach((path, id) => ids.set(path, id));
    const extern: string[] = [];
    const idOf = (path: string): number => {
      let id = ids.get(path);
      if (id === undefined) {
        id = paths.length + extern.length;
        ids.set(path, id);
        extern.push(path);
      }
      return id;
    };
    const report: PlanGroupReport = {
      directory,
      files: paths.length,
      answered: 0,
      left: new Map(),
    };
    const leave = (reason: PlanLeft): void => {
      report.left.set(reason, (report.left.get(reason) ?? 0) + 1);
    };
    const requests: (string | number)[][] = [];
    for (const path of paths) {
      const triples: (string | number)[] = [];
      requests.push(triples);
      const text = read(path);
      // Most of the pass is the tokenizer: a source with no string literal
      // that starts a relative specifier has nothing for the plan.
      if (text === null || !RELATIVE_LITERAL.test(text)) continue;
      const tokens = moduleTokens(text);
      const indirect = usesRequireIndirectly(tokens);
      const from = dirnameOf(path);
      for (const specifier of new Set(scanModuleSpecifiers(text, tokens).specifiers)) {
        if (!isRelativeSpecifier(specifier)) continue;
        if (!PLAIN_PATH.test(specifier) || specifier.includes("//")) {
          leave("a specifier with characters outside the plain set");
          continue;
        }
        let required: number = -1;
        let imported: number = -1;
        const byRequire: { path: string } | PlanLeft = indirect
          ? "the module uses require other than by calling it"
          : builder.require(from, specifier);
        const byImport = builder.import(from, specifier);
        // A target whose path the bootstrap cannot turn into a URL by
        // appending it is left to Node as well.
        const unnameable: PlanLeft = "a specifier with characters outside the plain set";
        const requireLeft =
          typeof byRequire === "string"
            ? byRequire
            : PLAIN_PATH.test(byRequire.path)
              ? null
              : unnameable;
        const importLeft =
          typeof byImport === "string"
            ? byImport
            : PLAIN_PATH.test(byImport.path)
              ? null
              : unnameable;
        if (requireLeft === null) required = idOf((byRequire as { path: string }).path);
        if (importLeft === null) imported = idOf((byImport as { path: string }).path);
        if (requireLeft !== null && importLeft !== null) {
          // Answered under neither loader: counted once, by require's reason.
          leave(requireLeft);
          continue;
        }
        report.answered++;
        triples.push(specifier, required, imported);
      }
    }
    const document: GroupDocument = {
      files: paths.map((path) => path.slice(prefix.length)),
      extern,
      requests,
    };
    documents.push({ directory, text: JSON.stringify(document) });
    reports.push(report);
  }
  // The header maps each group's directory to the byte range of its
  // document, counted from the end of the header line.
  const encoder = new TextEncoder();
  const bodies = documents.map((d) => encoder.encode(d.text));
  const ranges: [string, number, number][] = [];
  let offset = 0;
  documents.forEach((d, i) => {
    ranges.push([d.directory, offset, bodies[i]!.length]);
    offset += bodies[i]!.length;
  });
  const header = encoder.encode(`${JSON.stringify({ v: 1, groups: ranges })}\n`);
  const bytes = new Uint8Array(header.length + offset);
  bytes.set(header, 0);
  let at = header.length;
  for (const body of bodies) {
    bytes.set(body, at);
    at += body.length;
  }
  return { bytes, groups: reports };
}

function tracePlan(plan: LoadPlan): void {
  const trace = process.env["SCRIPTC_NODE_ISLANDS_TRACE"];
  if (trace === undefined || !trace.includes("plan")) return;
  for (const group of plan.groups) {
    const left = [...group.left]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([reason, count]) => `${count} ${reason}`);
    process.stderr.write(
      `[node-islands] plan ${group.directory === "" ? "(program modules)" : group.directory}: ${group.files} files, ${group.answered} relative requests answered${left.length === 0 ? "" : `; left to Node: ${left.join(", ")}`}\n`,
    );
  }
  process.stderr.write(`[node-islands] plan: ${plan.bytes.length} bytes at ${LOAD_PLAN_PATH}\n`);
}

/** Adds the load plan to a tree about to ship: its manifest entry, and its
 * bytes in the returned map (readNodeIslandModules and
 * placeNodeIslandModules take them: the file exists nowhere on disk). A
 * tree with nothing to plan ships without one, and Node resolves as before.
 * So does a tree that already holds a file at the plan's path, unless that
 * file is this plan (the same tree planned again): the two are told apart
 * by content. */
export function planNodeIslandLoads(modules: IrNodeIslandModules): Map<string, Uint8Array> {
  const generated = new Map<string, Uint8Array>();
  const existing = modules.files.findIndex((file) => file.path === LOAD_PLAN_PATH);
  const files = existing < 0 ? modules.files : modules.files.filter((_, at) => at !== existing);
  const plan = buildLoadPlan({ files, links: modules.links }, (path) => {
    try {
      return readFileSync(join(modules.root, ...path.split("/")), "utf8");
    } catch {
      return null;
    }
  });
  if (plan === null) return generated;
  const entry = {
    path: LOAD_PLAN_PATH,
    size: plan.bytes.length,
    sha256: createSha256(plan.bytes),
  };
  if (existing >= 0) {
    const held = modules.files[existing]!;
    if (held.size === entry.size && held.sha256 === entry.sha256)
      generated.set(LOAD_PLAN_PATH, plan.bytes);
    return generated;
  }
  tracePlan(plan);
  // The manifest stays sorted by path.
  let at = modules.files.findIndex((file) => file.path > LOAD_PLAN_PATH);
  if (at < 0) at = modules.files.length;
  modules.files.splice(at, 0, entry);
  generated.set(LOAD_PLAN_PATH, plan.bytes);
  return generated;
}

function createSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
