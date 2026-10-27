/** Node package resolution shared by preflight and native module introspection. */
import { dirname, join, resolve } from "node:path";
import { packageNameOfSpecifier as packageNameOf } from "./workspace-registry.js";
import {
  trackedDirectoryExists,
  trackedFileExists,
  trackedReadFile,
  trackedRealpath,
} from "./input-tracker.js";
import { isUnloadedPackage } from "./package-shims.js";
import { resolveExports, resolvePackageImports } from "./resolve.js";

const NODE_IMPORT_CONDITIONS = new Set(["import", "node", "default"]);

const NODE_REQUIRE_CONDITIONS = new Set(["require", "node", "default"]);

function nodeExportConditions(mode: "import" | "require"): ReadonlySet<string> {
  return mode === "import" ? NODE_IMPORT_CONDITIONS : NODE_REQUIRE_CONDITIONS;
}

export interface NpmGraphHost {
  readFile: (path: string) => string | null;
  isFile: (path: string) => boolean;
  isDirectory: (path: string) => boolean;
  /** fs.realpathSync semantics; returns the input when resolution fails. */
  realpath: (path: string) => string;
}

export const realNpmGraphHost: NpmGraphHost = {
  readFile: (path) => {
    return trackedReadFile(path);
  },
  isFile: (path) => trackedFileExists(path),
  isDirectory: (path) => trackedDirectoryExists(path),
  realpath: (path) => trackedRealpath(path) ?? path,
};

interface PkgJson {
  name?: string;
  main?: string;
  module?: string;
  type?: string;
  exports?: unknown;
  imports?: unknown;
}

export function packageNameOfPath(path: string): string | null {
  const norm = path.split("\\").join("/");
  const idx = norm.lastIndexOf("/node_modules/");
  if (idx === -1) return null;
  const rest = norm.slice(idx + "/node_modules/".length);
  return rest === "" ? null : packageNameOf(rest);
}

export interface NodeImportRefusal {
  message: string;
  code: "ERR_MODULE_NOT_FOUND" | "ERR_PACKAGE_PATH_NOT_EXPORTED";
  /** file:// url of the missing resolved target, when the refusal has one
   * (Node's ERR_MODULE_NOT_FOUND carries it for resolved-but-missing). */
  url?: string;
}

export function probeNodeImportRefusal(
  fromFile: string,
  specifier: string,
  host: NpmGraphHost = realNpmGraphHost,
): NodeImportRefusal | null {
  if (specifier.startsWith("#") || specifier.startsWith("node:")) return null;
  const name = packageNameOf(specifier);
  // A package the project marks never loaded resolves like a missing one.
  if (isUnloadedPackage(specifier)) {
    return {
      code: "ERR_MODULE_NOT_FOUND",
      message: `Cannot find package '${name}' imported from ${resolve(fromFile)}`,
    };
  }
  const parts = specifier.split("/");
  const subparts = specifier.startsWith("@") ? parts.slice(2) : parts.slice(1);
  const subpath = subparts.length > 0 ? `./${subparts.join("/")}` : ".";
  const importer = resolve(fromFile);
  const pkgJsonAt = (dir: string): PkgJson | null => {
    const text = host.readFile(join(dir, "package.json"));
    if (text === null) return null;
    try {
      return JSON.parse(text) as PkgJson;
    } catch {
      return null;
    }
  };
  // The final answer within one package scope (self or node_modules):
  // Node's PACKAGE_EXPORTS_RESOLVE outcome for the subpath.
  const withinScope = (pkgDir: string, pkg: PkgJson): NodeImportRefusal | null => {
    if (pkg.exports === undefined) return null; // legacy resolution — conservative
    const target = resolveExports(pkg.exports, subpath, NODE_IMPORT_CONDITIONS);
    if (target === null) {
      return {
        code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
        message:
          subpath === "."
            ? `No "exports" main defined in ${join(pkgDir, "package.json")} imported from ${importer}`
            : `Package subpath '${subpath}' is not defined by "exports" in ${join(pkgDir, "package.json")} imported from ${importer}`,
      };
    }
    const file = join(pkgDir, target);
    if (host.isFile(file)) return null;
    if (host.isDirectory(file)) return null; // ERR_UNSUPPORTED_DIR_IMPORT territory — conservative
    return {
      code: "ERR_MODULE_NOT_FOUND",
      message: `Cannot find module '${file}' imported from ${importer}`,
      url: `file://${file}`,
    };
  };
  // Node's PACKAGE_SELF_RESOLVE first: the nearest package scope above the
  // importer whose "name" matches AND that carries "exports" answers —
  // finally (its refusals do NOT fall back to node_modules).
  for (let dir = dirname(importer); ;) {
    const pkg = pkgJsonAt(dir);
    if (pkg) {
      if (pkg.name === name && pkg.exports !== undefined) return withinScope(dir, pkg);
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (let dir = dirname(importer); ;) {
    const linkDir = join(dir, "node_modules", name);
    if (host.isDirectory(linkDir)) {
      const pkgDir = host.realpath(linkDir);
      const pkg = pkgJsonAt(pkgDir);
      if (pkg === null) return null; // unreadable manifest — conservative
      return withinScope(pkgDir, pkg);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return {
        code: "ERR_MODULE_NOT_FOUND",
        message: `Cannot find package '${name}' imported from ${importer}`,
      };
    }
    dir = parent;
  }
}

export function probeNodeRequireRefusal(
  fromFile: string,
  specifier: string,
  host: NpmGraphHost = realNpmGraphHost,
): { message: string } | null {
  if (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("node:")
  ) {
    return null;
  }
  const name = packageNameOf(specifier);
  const importer = resolve(fromFile);
  // A package the project marks never loaded (package-shims.ts) throws
  // exactly what Node throws when it is not installed.
  if (isUnloadedPackage(specifier)) {
    return { message: `Cannot find module '${specifier}'\nRequire stack:\n- ${importer}` };
  }
  for (let dir = dirname(importer); ;) {
    // A self-scope whose "name" matches: Node's require honors package
    // self-reference — conservative null (resolvable or its own story).
    const pkgText = host.readFile(join(dir, "package.json"));
    if (pkgText !== null) {
      try {
        if ((JSON.parse(pkgText) as PkgJson).name === name) return null;
      } catch {
        return null; // unreadable manifest — conservative
      }
    }
    if (host.isDirectory(join(dir, "node_modules", name))) return null;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {
    message: `Cannot find module '${specifier}'\nRequire stack:\n- ${importer}`,
  };
}

export class NodePackageResolver {
  private readonly errors: { message: string }[] = [];
  private readonly pkgJsonCache = new Map<string, PkgJson | null>();
  private readonly formatOverrides = new Map<string, "esm" | "cjs" | "json">();
  constructor(private readonly host: NpmGraphHost = realNpmGraphHost) {}

  resolveForIntrospection(
    fromFile: string,
    specifier: string,
    mode: "import" | "require",
  ): string | null {
    const before = this.errors.length;
    const key = this.resolvePackage(dirname(resolve(fromFile)), specifier, mode, {
      importer: resolve(fromFile),
      chain: [],
      preferModuleField: false,
    });
    this.errors.length = before;
    return key;
  }

  private pkgJsonOf(dir: string): PkgJson | null {
    let cached = this.pkgJsonCache.get(dir);
    if (cached === undefined) {
      const text = this.host.readFile(join(dir, "package.json"));
      cached = text === null ? null : (JSON.parse(text) as PkgJson);
      this.pkgJsonCache.set(dir, cached);
    }
    return cached;
  }

  private resolveFile(path: string, depth = 0): string | null {
    if (depth > 8) return null; // a "main" cycle — refuse quietly
    if (this.host.isFile(path)) return path;
    for (const ext of [".js", ".json", ".mjs", ".cjs", ".node"]) {
      if (this.host.isFile(path + ext)) return path + ext;
    }
    if (this.host.isDirectory(path)) {
      const dir = this.host.realpath(path);
      const main = this.pkgJsonOf(dir)?.main;
      if (typeof main === "string" && main !== "") {
        const viaMain = this.resolveFile(join(dir, main), depth + 1);
        if (viaMain) return viaMain;
      }
      for (const idx of ["index.js", "index.json", "index.mjs", "index.cjs", "index.node"]) {
        const p = join(path, idx);
        if (this.host.isFile(p)) return p;
      }
    }
    return null;
  }

  private static chainOf(chain: readonly string[], last?: string): string {
    const full = last === undefined ? chain : [...chain, last];
    return full.join(" → ");
  }

  private resolvePackage(
    fromDir: string,
    specifier: string,
    mode: "import" | "require",
    ctx: { importer: string; chain: readonly string[]; preferModuleField?: boolean },
  ): string | null {
    if (specifier.startsWith("#")) {
      return this.resolvePackageImport(fromDir, specifier, mode, ctx);
    }
    const name = packageNameOf(specifier);
    const parts = specifier.split("/");
    const subparts = specifier.startsWith("@") ? parts.slice(2) : parts.slice(1);
    const subpath = subparts.length > 0 ? `./${subparts.join("/")}` : ".";
    const chain = NodePackageResolver.chainOf(ctx.chain, name);
    // Node's PACKAGE_SELF_RESOLVE runs BEFORE any node_modules lookup: the
    // nearest package scope above the importing module whose "name" equals
    // the specifier's package name AND that carries "exports" answers the
    // specifier through its OWN exports map — finally (a refusal there
    // never falls back to node_modules). Common in packages whose internal
    // modules import the package by its published name (benign self-
    // reference cycles); without this rule the up-walk only finds the
    // package when it happens to sit under a node_modules/<name> path.
    for (let dir = fromDir; ;) {
      const selfPkg = this.pkgJsonOf(dir);
      if (selfPkg) {
        if (selfPkg.name === name && selfPkg.exports !== undefined) {
          const fromExports = resolveExports(selfPkg.exports, subpath, nodeExportConditions(mode));
          if (fromExports === null) {
            this.errors.push({
              message:
                `package '${name}' does not export '${subpath}' in its package.json "exports"` +
                ` (self-reference; imported from ${ctx.importer}; dependency chain: ${chain})`,
            });
            return null;
          }
          const resolved = this.resolveFile(join(dir, fromExports));
          if (!resolved) {
            this.errors.push({
              message:
                `package '${name}' resolves its ${subpath === "." ? "entry" : `'${subpath}'`} to '${fromExports}', which does not exist` +
                ` (self-reference; imported from ${ctx.importer}; dependency chain: ${chain})`,
            });
            return null;
          }
          return this.host.realpath(resolved);
        }
        break; // nearest scope decides self-reference — matching or not
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (let dir = fromDir; ;) {
      const linkDir = join(dir, "node_modules", name);
      const pkgDir = this.host.isDirectory(linkDir) ? this.host.realpath(linkDir) : null;
      const pkg = pkgDir !== null ? this.pkgJsonOf(pkgDir) : null;
      if (pkgDir !== null && pkg !== null) {
        let target: string;
        let forceEsm = false;
        if (pkg.exports !== undefined) {
          const fromExports = resolveExports(pkg.exports, subpath, nodeExportConditions(mode));
          if (fromExports === null) {
            this.errors.push({
              message:
                `package '${name}' does not export '${subpath}' in its package.json "exports"` +
                ` (imported from ${ctx.importer}; dependency chain: ${chain})`,
            });
            return null;
          }
          target = fromExports;
        } else if (subpath !== ".") {
          target = subpath;
        } else if (
          mode === "import" &&
          ctx.preferModuleField !== false &&
          typeof pkg.module === "string" &&
          pkg.module !== ""
        ) {
          // No "exports": the "module" field names the ESM build (a
          // bundler convention Node itself ignores; embedding prefers the
          // real ES module over require-shimming the CJS "main").
          target = pkg.module;
          forceEsm = true;
        } else {
          target = pkg.main && pkg.main !== "" ? pkg.main : "index.js";
        }
        const resolved = this.resolveFile(join(pkgDir, target));
        if (!resolved) {
          this.errors.push({
            message:
              `package '${name}' resolves its ${subpath === "." ? "entry" : `'${subpath}'`} to '${target}', which does not exist` +
              ` (imported from ${ctx.importer}; dependency chain: ${chain})`,
          });
          return null;
        }
        const key = this.host.realpath(resolved);
        if (forceEsm && !key.endsWith(".mjs") && !key.endsWith(".cjs") && !key.endsWith(".json")) {
          this.formatOverrides.set(key, "esm");
        }
        return key;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        this.errors.push({
          message:
            `cannot find package '${name}' in any node_modules from ${fromDir} up to the root` +
            ` (imported from ${ctx.importer}${ctx.chain.length > 0 ? `; dependency chain: ${chain}` : ""})`,
        });
        return null;
      }
      dir = parent;
    }
  }

  private resolvePackageImport(
    fromDir: string,
    specifier: string,
    mode: "import" | "require",
    ctx: { importer: string; chain: readonly string[]; preferModuleField?: boolean },
  ): string | null {
    let pkgDir: string | null = null;
    let pkg: PkgJson | null = null;
    for (let dir = fromDir; ;) {
      const candidate = this.pkgJsonOf(dir);
      if (candidate !== null) {
        pkgDir = dir;
        pkg = candidate;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const chain = NodePackageResolver.chainOf(ctx.chain);
    if (pkgDir === null || pkg === null) {
      this.errors.push({
        message:
          `package import '${specifier}' has no enclosing package.json` +
          ` (imported from ${ctx.importer}${chain === "" ? "" : `; dependency chain: ${chain}`})`,
      });
      return null;
    }
    if (specifier === "#") {
      this.errors.push({
        message:
          `package import '#' is not a valid internal specifier` +
          ` (imported from ${ctx.importer}${chain === "" ? "" : `; dependency chain: ${chain}`})`,
      });
      return null;
    }
    const target = resolvePackageImports(pkg.imports, specifier, nodeExportConditions(mode));
    if (target === null) {
      this.errors.push({
        message:
          `package import '${specifier}' is not defined by "imports" in ${join(pkgDir, "package.json")}` +
          ` (imported from ${ctx.importer}${chain === "" ? "" : `; dependency chain: ${chain}`})`,
      });
      return null;
    }
    if (target.startsWith("./")) {
      const resolved = this.resolveFile(join(pkgDir, target));
      if (resolved === null) {
        this.errors.push({
          message:
            `package import '${specifier}' resolves to '${target}', which does not exist` +
            ` (imported from ${ctx.importer}${chain === "" ? "" : `; dependency chain: ${chain}`})`,
        });
        return null;
      }
      return this.host.realpath(resolved);
    }
    if (
      target.startsWith("#") ||
      target.startsWith("../") ||
      target.startsWith("/") ||
      target === "." ||
      target === ".."
    ) {
      this.errors.push({
        message:
          `package import '${specifier}' has invalid target '${target}' in ${join(pkgDir, "package.json")}` +
          ` (imported from ${ctx.importer}${chain === "" ? "" : `; dependency chain: ${chain}`})`,
      });
      return null;
    }
    return this.resolvePackage(pkgDir, target, mode, ctx);
  }
}
