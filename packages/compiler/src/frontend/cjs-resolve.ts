/** Filesystem-only CommonJS introspection. This follows the pinned Node 24
 * default resolver, without loading modules, invoking hooks, or selecting
 * TypeScript declarations. In particular exports/imports targets are exact
 * files; only legacy requests try .js/.json/.node and directory indexes.
 * Every filesystem observation passes through the frontend input tracker. */
import { isBuiltin } from "node:module";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
  sep,
  toNamespacedPath,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  hostFact,
  trackedDirectoryExists,
  trackedFileExists,
  trackedHostFact,
  trackedReadFile,
  trackedRealpath,
} from "./input-tracker.js";
import type { RuntimeResolveError, RuntimeResolveResult } from "./runtime-resolve.js";

interface PackageConfig {
  path: string;
  data: Record<string, unknown>;
}

class ResolveFailure extends Error {
  constructor(readonly detail: RuntimeResolveError) {
    super(detail.message);
  }
}

function fail(code: string, message: string, name = "Error"): never {
  throw new ResolveFailure({ name, code, message });
}

function missing(request: string, parent: string | null): never {
  fail(
    "MODULE_NOT_FOUND",
    `Cannot find module '${request}'${parent === null ? "" : `\nRequire stack:\n- ${parent}`}`,
  );
}

function relativeRequest(request: string): boolean {
  return (
    request === "." ||
    request === ".." ||
    request.startsWith("./") ||
    request.startsWith("../") ||
    (process.platform === "win32" && (request.startsWith(".\\") || request.startsWith("..\\")))
  );
}

/** Node intentionally skips node_modules/node_modules while walking upward. */
export function cjsNodeModulePaths(fromDirectory: string): string[] {
  const from = resolve(fromDirectory);
  const paths: string[] = [];
  if (process.platform === "win32") {
    if (from.endsWith(":\\")) return [from + "node_modules"];
    // Node's Windows walk includes UNC server roots and preserves their
    // separator spelling. dirname/join would stop early at the share root.
    let end = from.length;
    for (let index = from.length - 1; index >= 0; index--) {
      const character = from.charAt(index);
      if (character !== "\\" && character !== "/" && character !== ":") continue;
      if (from.slice(index + 1, end) !== "node_modules")
        paths.push(from.slice(0, end) + "\\node_modules");
      end = index;
    }
    return paths;
  }
  for (let directory = from; ; directory = dirname(directory)) {
    if (basename(directory) !== "node_modules") paths.push(join(directory, "node_modules"));
    if (dirname(directory) === directory) break;
  }
  return paths;
}

/** The host facts the legacy lookup locations come from (hostFact), with
 * the values they had when this module loaded: the environment is captured
 * once, as Node does during module initialization. */
const globalPathFacts: [string, string | null][] = [
  "prefix",
  process.platform === "win32" ? "env:USERPROFILE" : "env:HOME",
  "env:NODE_PATH",
].map((name) => [name, hostFact(name)]);

/** Match the default host's legacy lookup locations. Native compiler clients
 * use their own executable prefix, so they need no installed Node executable. */
function initialGlobalPaths(): string[] {
  const [prefixFact, homeFact, nodePathFact] = globalPathFacts;
  const paths = [resolve(prefixFact![1] ?? "", "lib", "node")];
  const homeDirectory = homeFact![1];
  if (homeDirectory)
    paths.unshift(
      resolve(homeDirectory, ".node_modules"),
      resolve(homeDirectory, ".node_libraries"),
    );
  const nodePath = nodePathFact![1];
  if (nodePath) paths.unshift(...nodePath.split(delimiter).filter((part) => part !== ""));
  return paths;
}
const initialPaths = initialGlobalPaths();

/** The legacy lookup locations, for a resolution that consults them. The
 * facts they come from are recorded as inputs of the running frontend, so
 * its cache entry is not reused under another home directory, NODE_PATH or
 * compiler location; the directories themselves are probed through the
 * tracked filesystem like every other candidate. */
function globalPaths(): string[] {
  for (const [name, value] of globalPathFacts) trackedHostFact(name, value);
  return initialPaths;
}

/** Record the process's working directory when a resolution can depend on
 * it: a caller's lookup path that is not absolute is resolved from there
 * (cjsNodeModulePaths), and so is the request under it. The directory is an
 * input like any other, so a cache entry recorded under one directory is not
 * reused for a build started in another. */
function trackRelativeLookupPaths(request: string, paths: readonly string[] | undefined): void {
  if (paths === undefined || isAbsolute(request)) return;
  if (paths.some((path) => !isAbsolute(path))) trackedHostFact("cwd");
}

function parentFile(fromFile: string): string {
  return resolve(
    fromFile.endsWith(sep) || fromFile.endsWith("/") ? join(fromFile, "noop.js") : fromFile,
  );
}

export function cjsResolvePaths(fromFile: string, request: string): string[] | null {
  if (isBuiltin(request)) return null;
  fromFile = parentFile(fromFile);
  // _resolveLookupPaths has a wider dot-prefix test than isRelative, notably
  // for names such as "...". Keep these two Node rules separate.
  if (
    request.startsWith(".") &&
    (request.length === 1 ||
      request[1] === "." ||
      request[1] === "/" ||
      (process.platform === "win32" && request[1] === "\\"))
  )
    return [dirname(fromFile)];
  return [...cjsNodeModulePaths(dirname(fromFile)), ...globalPaths()];
}

const extensions = [".js", ".json", ".node"];
const requireConditions = new Set(["node", "require", "node-addons", "module-sync", "default"]);
const packageRequest = /^((?:@[^/\\%]+\/)?[^./\\%][^/\\%]*)(\/.*)?$/;
const invalidSegment =
  /(^|\\|\/)((\.|%2e)(\.|%2e)?|(n|%6e|%4e)(o|%6f|%4f)(d|%64|%44)(e|%65|%45)(_|%5f)(m|%6d|%4d)(o|%6f|%4f)(d|%64|%44)(u|%75|%55)(l|%6c|%4c)(e|%65|%45)(s|%73|%53))(\\|\/|$)/i;

function absoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

class CjsResolver {
  private readonly packages = new Map<string, PackageConfig | null>();

  private package(directory: string): PackageConfig | null {
    const path = join(directory, "package.json");
    const cached = this.packages.get(path);
    if (cached !== undefined) return cached;
    const text = trackedReadFile(path);
    if (text === null) {
      this.packages.set(path, null);
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      fail("ERR_INVALID_PACKAGE_CONFIG", `Invalid package config ${toNamespacedPath(path)}.`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail("ERR_INVALID_PACKAGE_CONFIG", `Invalid package config ${toNamespacedPath(path)}.`);
    }
    const data = value as Record<string, unknown>;
    // Node's package reader only exposes non-null string/object map fields.
    for (const field of ["exports", "imports"]) {
      const entry = data[field];
      if (entry === null || (typeof entry !== "string" && typeof entry !== "object"))
        delete data[field];
    }
    const pkg: PackageConfig = { path, data };
    this.packages.set(path, pkg);
    return pkg;
  }

  private scope(fromFile: string): PackageConfig | null {
    for (
      let directory = dirname(fromFile);
      basename(directory) !== "node_modules";
      directory = dirname(directory)
    ) {
      const pkg = this.package(directory);
      if (pkg !== null) return pkg;
      if (dirname(directory) === directory) break;
    }
    return null;
  }

  private file(path: string): string | null {
    return trackedFileExists(path) ? trackedRealpath(path) : null;
  }

  private withExtensions(path: string): string | null {
    for (const extension of extensions) {
      const file = this.file(path + extension);
      if (file !== null) return file;
    }
    return null;
  }

  private directory(path: string): string | null {
    const main = this.package(path)?.data["main"];
    if (typeof main !== "string" || main === "") return this.withExtensions(join(path, "index"));
    const filename = resolve(path, main);
    // Node does not recursively consult another package.json under main.
    const result =
      this.file(filename) ??
      this.withExtensions(filename) ??
      this.withExtensions(join(filename, "index")) ??
      this.withExtensions(join(path, "index"));
    if (result !== null) return result;
    fail(
      "MODULE_NOT_FOUND",
      `Cannot find module '${filename}'. Please verify that the package.json has a valid "main" entry`,
    );
  }

  private legacy(path: string, request: string): string | null {
    const trailing = /(?:\/|(?:^|\/)\.{1,2})$/.test(request);
    if (!trailing) {
      const file = this.file(path) ?? this.withExtensions(path);
      if (file !== null) return file;
    }
    return trackedDirectoryExists(path) ? this.directory(path) : null;
  }

  private invalidConfig(pkg: PackageConfig, base: string | null, message: string): never {
    fail(
      "ERR_INVALID_PACKAGE_CONFIG",
      `Invalid package config ${pkg.path}${base ? ` while importing ${pathToFileURL(base).href}` : ""}. ${message}`,
    );
  }

  private invalidTarget(
    pkg: PackageConfig,
    key: string,
    target: unknown,
    internal: boolean,
    base: string | null,
  ): never {
    const text =
      typeof target === "object" && target !== null ? JSON.stringify(target) : String(target);
    const label = key === "." ? '"exports" main' : `"${internal ? "imports" : "exports"}"`;
    const forKey = key === "." ? "" : ` for '${key}'`;
    const relative =
      typeof target === "string" && !internal && target !== "" && !target.startsWith("./");
    fail(
      "ERR_INVALID_PACKAGE_TARGET",
      `Invalid ${label} target ${JSON.stringify(text)} defined${forKey} in the package config ${pkg.path}${base ? ` imported from ${base}` : ""}${relative ? '; targets must start with "./"' : ""}`,
    );
  }

  private invalidSpecifier(request: string, reason: string, base: string | null): never {
    fail(
      "ERR_INVALID_MODULE_SPECIFIER",
      `Invalid module "${request}" ${reason}${base ? ` imported from ${base}` : ""}`,
      "TypeError",
    );
  }

  /** undefined means no matching condition; null is an explicitly blocked
   * target. A null conditional arm must not fall through to default. */
  private target(
    pkg: PackageConfig,
    value: unknown,
    key: string,
    wildcard: string | null,
    internal: boolean,
    base: string | null,
  ): string | null | undefined {
    if (typeof value === "string") {
      if (!value.startsWith("./")) {
        if (internal && !value.startsWith("/") && !value.startsWith("../") && !absoluteUrl(value)) {
          const request = wildcard === null ? value : value.split("*").join(wildcard);
          return this.importPackage(pkg, request);
        }
        this.invalidTarget(pkg, key, value, internal, base);
      }
      if (invalidSegment.test(value.slice(2))) this.invalidTarget(pkg, key, value, internal, base);
      const url = new URL(value, pathToFileURL(pkg.path));
      const packageUrl = new URL(".", pathToFileURL(pkg.path));
      if (!url.pathname.startsWith(packageUrl.pathname))
        this.invalidTarget(pkg, key, value, internal, base);
      if (wildcard !== null) {
        if (invalidSegment.test(wildcard)) {
          this.invalidSpecifier(
            key.replace("*", wildcard),
            `request is not a valid match in pattern "${key}" for the "${internal ? "imports" : "exports"}" resolution of ${pkg.path}`,
            base,
          );
        }
        return new URL(url.href.split("*").join(wildcard)).href;
      }
      return url.href;
    }
    if (Array.isArray(value)) {
      let lastFailure: ResolveFailure | null = null;
      let blocked = false;
      for (const item of value) {
        try {
          const result = this.target(pkg, item, key, wildcard, internal, base);
          if (result === undefined) continue;
          if (result === null) {
            lastFailure = null;
            blocked = true;
            continue;
          }
          return result;
        } catch (error) {
          if (
            !(error instanceof ResolveFailure) ||
            error.detail.code !== "ERR_INVALID_PACKAGE_TARGET"
          )
            throw error;
          lastFailure = error;
        }
      }
      if (lastFailure !== null) throw lastFailure;
      return blocked || value.length === 0 ? null : undefined;
    }
    if (value !== null && typeof value === "object") {
      const conditions = value as Record<string, unknown>;
      const keys = Object.keys(conditions);
      for (const condition of keys) {
        const number = Number(condition);
        if (`${number}` === condition && number >= 0 && number < 0xffff_ffff) {
          this.invalidConfig(pkg, base, '"exports" cannot contain numeric property keys.');
        }
      }
      for (const condition of keys) {
        if (!requireConditions.has(condition)) continue;
        const result = this.target(pkg, conditions[condition], key, wildcard, internal, base);
        if (result !== undefined) return result;
      }
      return undefined;
    }
    if (value === null) return null;
    this.invalidTarget(pkg, key, value, internal, base);
  }

  private mapTarget(
    pkg: PackageConfig,
    map: Record<string, unknown>,
    request: string,
    internal: boolean,
    base: string | null,
  ): string | null | undefined {
    if (
      Object.hasOwn(map, request) &&
      !request.includes("*") &&
      (internal || !request.endsWith("/"))
    ) {
      return this.target(pkg, map[request], request, null, internal, base);
    }
    let best = "";
    let prefixLength = -1;
    for (const key of Object.keys(map)) {
      const star = key.indexOf("*");
      if (
        star < 0 ||
        key.lastIndexOf("*") !== star ||
        request.length < key.length ||
        !request.startsWith(key.slice(0, star)) ||
        !request.endsWith(key.slice(star + 1))
      )
        continue;
      if (star > prefixLength || (star === prefixLength && key.length > best.length)) {
        best = key;
        prefixLength = star;
      }
    }
    if (best === "") return undefined;
    const wildcard = request.slice(prefixLength, request.length - (best.length - prefixLength - 1));
    return this.target(pkg, map[best], best, wildcard, internal, base);
  }

  private exports(pkg: PackageConfig, request: string, base: string | null): string {
    const value = pkg.data["exports"];
    let result: string | null | undefined;
    if (typeof value === "string" || Array.isArray(value)) {
      result = request === "." ? this.target(pkg, value, ".", null, false, base) : null;
    } else if (typeof value === "object" && value !== null) {
      const map = value as Record<string, unknown>;
      const keys = Object.keys(map);
      const subpaths = keys.filter((key) => key.startsWith("."));
      if (subpaths.length !== 0 && subpaths.length !== keys.length) {
        this.invalidConfig(
          pkg,
          base,
          "\"exports\" cannot contain some keys starting with '.' and some not. The exports object must either be an object of package subpath keys or an object of main entry condition name keys only.",
        );
      }
      result =
        subpaths.length > 0
          ? this.mapTarget(pkg, map, request, false, base)
          : request === "."
            ? this.target(pkg, map, ".", null, false, base)
            : null;
    }
    if (result != null) return result;
    const message =
      request === "."
        ? `No "exports" main defined in ${pkg.path}`
        : `Package subpath '${request}' is not defined by "exports" in ${pkg.path}`;
    fail("ERR_PACKAGE_PATH_NOT_EXPORTED", message + (base ? ` imported from ${base}` : ""));
  }

  private finalize(url: string, base: string | null): string {
    if (/%2f|%5c/i.test(url))
      this.invalidSpecifier(url, 'must not include encoded "/" or "\\" characters', base);
    if (!url.startsWith("file:"))
      fail("ERR_INVALID_URL_SCHEME", "The URL must be of scheme file", "TypeError");
    let filename: string;
    try {
      filename = fileURLToPath(url);
    } catch (error) {
      if (error instanceof URIError) fail("", error.message, "URIError");
      throw error;
    }
    const file = this.file(filename);
    if (file !== null) return file;
    missing(filename, null);
  }

  /** A bare imports target re-enters ESM package resolution with the require
   * conditions. Legacy package roots probe extensions; subpaths stay exact. */
  private importPackage(from: PackageConfig, request: string): string {
    if (isBuiltin(request) && !request.startsWith("node:")) return `node:${request}`;
    const parts = request.split("/");
    const scoped = request.startsWith("@");
    const name = scoped ? `${parts[0]}/${parts[1] ?? ""}` : parts[0]!;
    if (
      name.startsWith(".") ||
      name.includes("%") ||
      name.includes("\\") ||
      (scoped && (parts.length < 2 || parts[1] === ""))
    ) {
      this.invalidSpecifier(request, "is not a valid package name", from.path);
    }
    const subpath = request.length === name.length ? "." : "." + request.slice(name.length);
    if (from.data["name"] === name && from.data["exports"] != null)
      return this.exports(from, subpath, from.path);
    for (const directory of cjsNodeModulePaths(dirname(from.path))) {
      const root = join(directory, name);
      if (!trackedDirectoryExists(root)) continue;
      const pkg = this.package(root);
      if (pkg !== null && pkg.data["exports"] != null) return this.exports(pkg, subpath, from.path);
      if (subpath !== ".") return new URL(subpath, pathToFileURL(join(root, "package.json"))).href;
      try {
        const found = this.directory(root);
        if (found !== null) return pathToFileURL(found).href;
      } catch (error) {
        if (!(error instanceof ResolveFailure) || error.detail.code !== "MODULE_NOT_FOUND")
          throw error;
      }
      break;
    }
    // The outer CJS imports resolver translates an ESM missing-package error.
    fail("ERR_MODULE_NOT_FOUND", request);
  }

  resolve(fromFile: string, request: string, paths: readonly string[] | undefined): string {
    if (isBuiltin(request)) return request;
    const scope = this.scope(fromFile);
    if (request.startsWith("#") && scope !== null && scope.data["imports"] != null) {
      if (request === "#" || request.endsWith("/"))
        this.invalidSpecifier(request, "is not a valid internal imports specifier name", fromFile);
      const imports = scope.data["imports"];
      try {
        const target =
          typeof imports === "object" && imports !== null
            ? this.mapTarget(scope, imports as Record<string, unknown>, request, true, fromFile)
            : null;
        if (target != null) return this.finalize(target, fromFile);
      } catch (error) {
        if (!(error instanceof ResolveFailure) || error.detail.code !== "ERR_MODULE_NOT_FOUND")
          throw error;
        missing(request, null);
      }
      fail(
        "ERR_PACKAGE_IMPORT_NOT_DEFINED",
        `Package import specifier "${request}" is not defined in package ${scope.path} imported from ${fromFile}`,
        "TypeError",
      );
    }
    if (scope !== null && scope.data["exports"] !== undefined) {
      const name = scope.data["name"];
      if (typeof name === "string" && (request === name || request.startsWith(name + "/"))) {
        return this.finalize(
          this.exports(scope, "." + request.slice(name.length), fromFile),
          fromFile,
        );
      }
    }
    trackRelativeLookupPaths(request, paths);
    let lookup: string[];
    if (isAbsolute(request)) lookup = [""];
    else if (paths === undefined) lookup = cjsResolvePaths(fromFile, request) ?? [];
    else if (relativeRequest(request)) lookup = [...paths];
    else {
      lookup = [];
      for (const path of paths) {
        for (const candidate of [...cjsNodeModulePaths(path), ...globalPaths()]) {
          if (!lookup.includes(candidate)) lookup.push(candidate);
        }
      }
    }
    const match = isAbsolute(request) ? null : packageRequest.exec(request);
    const inside = !relativeRequest(request) || !normalize(request).startsWith("..");
    for (const path of lookup) {
      if (inside && path !== "" && !trackedDirectoryExists(path)) continue;
      if (match !== null) {
        const pkg = this.package(resolve(path, match[1]!));
        if (pkg !== null && pkg.data["exports"] != null) {
          return this.finalize(this.exports(pkg, "." + (match[2] ?? ""), null), null);
        }
      }
      const found = this.legacy(resolve(path, request), request);
      if (found !== null) return found;
    }
    missing(request, fromFile);
  }
}

export function resolveCjsRuntime(
  fromFile: string,
  request: string,
  paths?: readonly string[],
): RuntimeResolveResult {
  // createRequire treats a directory URL as a synthetic noop.js parent.
  const parent = parentFile(fromFile);
  try {
    return { ok: true, value: new CjsResolver().resolve(parent, request, paths) };
  } catch (error) {
    if (error instanceof ResolveFailure) return { ok: false, error: error.detail };
    throw error;
  }
}
