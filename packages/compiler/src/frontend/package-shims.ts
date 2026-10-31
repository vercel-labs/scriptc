/** Package shims: npm packages that compile from an implementation module
 * shipped with scriptc instead of from their own published JavaScript, and
 * packages a project marks as never loaded.
 *
 * Two kinds of entries:
 *
 * - implementation: a built-in TypeScript module per supported major version
 *   (packages/compiler/shims/<name>/v<major>.ts). The importing package's
 *   INSTALLED version selects the entry, so a program with undici 5.x in one
 *   workspace package and 7.x in another compiles both, each against its own
 *   version's behavior. A package that is not installed, or whose major
 *   version has no entry, is not shimmed and resolves exactly as before.
 *
 *   The module edge goes through resolveProjectImport (preflight, module
 *   order, the CommonJS link) and resolveNpmImport7 / the pipeline's npm-edge
 *   walk skip the package. The checker sees the same module through the fs
 *   shadow: the installed package's types entry (index.d.ts) reads as a
 *   re-export of the shim, so types resolve per importer like the real
 *   package's declarations (tsconfig `paths` would map every importer to one
 *   file).
 *
 * - unloaded: a package the project declares never loaded
 *   (`"scriptc": { "packages": { "encoding": "unloaded" } }` in the entry's
 *   package.json). `require()` of it throws Node's MODULE_NOT_FOUND exactly
 *   as when the package is not installed, so the optional-dependency pattern
 *   `try { require("encoding") } catch {}` takes its absent branch, and the
 *   package never joins the program.
 *
 * - builtin alias: a polyfill package whose module IS a Node builtin on
 *   Node 24 at its installed major version (builtin-package-aliases.ts).
 *   A require of it compiles as the builtin expression at the require's
 *   position (npm-static-builtin-aliases.ts), so the package never joins
 *   the program.
 *
 * A configured stand-in (for example a no-op tracer for dd-trace) is an
 * implementation entry whose module the project supplies. Today a tsconfig
 * `paths` mapping already does that: resolveProjectImport honors project
 * paths for module edges and the checker uses the same map. A config
 * spelling (`"dd-trace": "./native-shims/dd-trace.ts"`) would add the path
 * as a project-owned implementation entry here.
 */
import { dirname, join, resolve } from "node:path";
import { packageShimRoot, tsgoPath } from "./dts-paths.js";
import { trackedDirectoryExists, trackedReadFile, trackedRealpath } from "./input-tracker.js";
import { readProjectConfig } from "../project-config.js";
import { packageNameOfSpecifier } from "./workspace-registry.js";
import {
  BUILTIN_ALIAS_PACKAGES,
  builtinAliasOf,
  type BuiltinAlias,
} from "./builtin-package-aliases.js";

interface ImplementationShim {
  /** npm package name. */
  name: string;
  /** Supported major versions and their entry modules, relative to the
   * shim root. */
  versions: ReadonlyMap<number, string>;
  /** Major versions without an entry module that `--npm-static` compiles
   * from the package's own published JavaScript. An installed version that
   * is in neither list stays out of the program. */
  sourceVersions?: ReadonlySet<number>;
  /** The entry has a default export (a CommonJS package's whole export
   * object, which a default import reads). */
  defaultExport?: boolean;
  /** The package's main file in every supported version: a bundler's copy
   * of it (a __commonJS chunk whose key names the package, its version
   * and this file) is the package itself. */
  mainFile: string;
  /** The package's declaration entry relative to its directory, when it
   * is not `index.d.ts` (a `.d.mts` or `.d.cts` entry included). */
  typesFile?: string;
  /** An alternative entry for this installation (relative to the shim
   * root), or undefined for the version's own entry. */
  variant?: (pkgDir: string) => string | undefined;
  /** Every variant entry, for the guard test that compiles each one. */
  variants?: readonly string[];
}

const IMPLEMENTATION_SHIMS: ReadonlyMap<string, ImplementationShim> = new Map<
  string,
  ImplementationShim
>([
  [
    "fs-extra",
    {
      name: "fs-extra",
      defaultExport: true,
      mainFile: "lib/index.js",
      versions: new Map([
        [8, "fs-extra/index.ts"],
        [9, "fs-extra/index.ts"],
        [10, "fs-extra/index.ts"],
        [11, "fs-extra/index.ts"],
      ]),
    },
  ],
  [
    "chalk",
    {
      name: "chalk",
      defaultExport: true,
      mainFile: "source/index.js",
      typesFile: "source/index.d.ts",
      versions: new Map([[5, "chalk/v5.ts"]]),
      sourceVersions: new Set([6]),
    },
  ],
  [
    "hot-shots",
    {
      name: "hot-shots",
      defaultExport: true,
      mainFile: "index.js",
      typesFile: "types.d.ts",
      versions: new Map([[8, "hot-shots/v8.ts"]]),
      // hot-shots' uds protocol loads the optional unix-dgram addon: where
      // it is installed, the entry with the native Unix datagram transport.
      variant: (pkgDir: string) =>
        installedPackageDir(join(pkgDir, "index.js"), "unix-dgram") === null
          ? undefined
          : "hot-shots/v8-unix-dgram.ts",
      variants: ["hot-shots/v8-unix-dgram.ts"],
    },
  ],
  [
    "@hono/node-server",
    {
      name: "@hono/node-server",
      mainFile: "dist/index.mjs",
      typesFile: "dist/index.d.mts",
      versions: new Map([[2, "hono-node-server/v2.ts"]]),
    },
  ],
  [
    "undici",
    {
      name: "undici",
      mainFile: "index.js",
      versions: new Map([
        [5, "undici/v5.ts"],
        [7, "undici/v7.ts"],
      ]),
    },
  ],
]);

/** The shim module that stands in for a bundled copy of a package's main
 * file (a __commonJS chunk keyed `…/<name>@<version>/…/<name>/<file>`), or
 * null when the package, version or file is not one the registry serves. */
export function packageShimForBundledFile(
  name: string,
  version: string,
  file: string,
): string | null {
  const shim = IMPLEMENTATION_SHIMS.get(name);
  if (shim === undefined || file.replace(/^\.\//, "") !== shim.mainFile) return null;
  const major = Number(/^(\d+)\./.exec(version)?.[1] ?? NaN);
  const entry = shim.versions.get(major);
  return entry === undefined ? null : join(packageShimRoot(), entry);
}

/** Bundled-copy forwarders: a virtual declaration module beside a bundle
 * (`<bundle>.<binding>.shim.d.ts`) that re-exports the shim standing in
 * for a bundled package, so the checker loads the shim through it, and
 * module resolution answers the shim itself for its path. */
const bundledForwarders = new Map<string, string>();

/** The forwarder declaration text for a bundled copy of a shimmed package
 * and records its path; the bundle's call sites require the forwarder's
 * extensionless path. */
export function bundledShimForwarder(declPath: string, shimPath: string): string {
  bundledForwarders.set(declPath.split("\\").join("/"), shimPath);
  const target = JSON.stringify(tsgoPath(shimPath));
  const shim = [...IMPLEMENTATION_SHIMS.values()].find((entry) =>
    [...entry.versions.values()].some((v) => join(packageShimRoot(), v) === shimPath),
  );
  const defaultLine = shim?.defaultExport === true ? `export { default } from ${target};\n` : "";
  return `// scriptc: this bundled package compiles from its built-in implementation.\nexport * from ${target};\n${defaultLine}`;
}

/** True for a bundled-copy forwarder's path (the --npm-static shadow keeps
 * it visible where it hides the package's other declaration files). */
export function isBundledShimForwarder(path: string): boolean {
  return bundledForwarders.has(path.split("\\").join("/"));
}

/** The shim a resolved module path forwards to, or the path itself. */
export function throughBundledShimForwarder(resolved: string): string {
  return bundledForwarders.get(resolved.split("\\").join("/")) ?? resolved;
}

/** Every implementation module the registry ships (absolute paths), for
 * the guard test that compiles each one. */
export function packageShimEntries(): string[] {
  const entries = new Set<string>();
  for (const shim of IMPLEMENTATION_SHIMS.values()) {
    for (const entry of shim.versions.values()) entries.add(join(packageShimRoot(), entry));
    for (const entry of shim.variants ?? []) entries.add(join(packageShimRoot(), entry));
  }
  return [...entries].sort();
}

/** Package names the project marks never loaded. */
let unloadedPackages: ReadonlySet<string> = new Set();

/** Reads the project's package-shim configuration: the `scriptc.packages`
 * entries marked "unloaded", and those with `"shapes": false`, in the
 * entry's nearest package.json (project-config.ts validates the rest).
 * Called once per program load. */
export function configurePackageShims(entryPath: string): void {
  const packages = new Set<string>();
  const noShapes = new Set<string>();
  for (const [name, setting] of readProjectConfig(entryPath).packages) {
    if (setting.unloaded) packages.add(name);
    if (!setting.shapes) noShapes.add(name);
  }
  unloadedPackages = packages;
  shapelessPackages = noShapes;
}

let shapelessPackages: ReadonlySet<string> = new Set();

/** Packages the project compiles without shape inference's overlay
 * (`"scriptc": { "packages": { "<name>": { "shapes": false } } }`). */
export function isShapelessPackage(name: string): boolean {
  return shapelessPackages.has(name);
}

/** True when `--npm-static` leaves the package `name` out of its package
 * list: the project marks it never loaded, or the registry implements it
 * and the version installed for `entryPath` has an entry module or is not
 * one of the entry's `sourceVersions`. */
export function npmStaticOmitsPackage(entryPath: string, name: string): boolean {
  if (unloadedPackages.has(name)) return true;
  const shim = IMPLEMENTATION_SHIMS.get(name);
  if (shim === undefined) return false;
  const dir = installedPackageDir(entryPath, name);
  const major = dir === null ? null : installedMajorVersion(dir, name);
  return major === null || shim.versions.has(major) || !shim.sourceVersions?.has(major);
}

/** True when `specifier` names a package the project marks never loaded. */
export function isUnloadedPackage(specifier: string): boolean {
  if (unloadedPackages.size === 0) return false;
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) {
    return false;
  }
  return unloadedPackages.has(packageNameOfSpecifier(specifier));
}

const installedCache = new Map<string, string | null>();

/** The installed package directory Node's resolution would reach for
 * `name` from `fromFile` (node_modules walked upward, realpath'd). */
function installedPackageDir(fromFile: string, name: string): string | null {
  const start = dirname(resolve(fromFile));
  const key = `${start}\0${name}`;
  const cached = installedCache.get(key);
  if (cached !== undefined) return cached;
  let found: string | null = null;
  for (let dir = start; ;) {
    const candidate = join(dir, "node_modules", name);
    if (trackedDirectoryExists(candidate)) {
      found = trackedRealpath(candidate) ?? candidate;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  installedCache.set(key, found);
  return found;
}

/** The installed package's name and major version from its package.json,
 * or null when either is missing. */
function installedPackageVersion(pkgDir: string): { name: string; major: number } | null {
  const text = trackedReadFile(join(pkgDir, "package.json"));
  if (text === null) return null;
  let pkg: { name?: unknown; version?: unknown };
  try {
    pkg = JSON.parse(text) as { name?: unknown; version?: unknown };
  } catch {
    return null;
  }
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string") return null;
  return { name: pkg.name, major: Number(/^(\d+)\./.exec(pkg.version)?.[1] ?? NaN) };
}

/** The major version of the package `name` installed at `pkgDir`, or null. */
function installedMajorVersion(pkgDir: string, name: string): number | null {
  const installed = installedPackageVersion(pkgDir);
  return installed === null || installed.name !== name ? null : installed.major;
}

/** The shim entry for an installed package directory, or null when the
 * directory is not a registered package at a supported major version. */
function shimEntryForPackageDir(pkgDir: string, expectedName: string | null): string | null {
  const installed = installedPackageVersion(pkgDir);
  if (installed === null) return null;
  if (expectedName !== null && installed.name !== expectedName) return null;
  const shim = IMPLEMENTATION_SHIMS.get(installed.name);
  if (shim === undefined) return null;
  const entry = shim.versions.get(installed.major);
  if (entry === undefined) return null;
  return join(packageShimRoot(), shim.variant?.(pkgDir) ?? entry);
}

/** The shim module `specifier` resolves to from `fromFile`, or null. Only
 * the package's main entry is shimmed; subpath imports resolve as before. */
export function packageShimFor(fromFile: string, specifier: string): string | null {
  if (!IMPLEMENTATION_SHIMS.has(specifier)) return null;
  const dir = installedPackageDir(fromFile, specifier);
  return dir === null ? null : shimEntryForPackageDir(dir, specifier);
}

/** The builtin a bare specifier's module is on Node 24, as installed where
 * Node's resolution from `fromFile` finds it, or null. A package the
 * project marks unloaded has no alias: its require throws MODULE_NOT_FOUND. */
export function builtinPackageAliasFor(fromFile: string, specifier: string): BuiltinAlias | null {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#"))
    return null;
  if (isUnloadedPackage(specifier)) return null;
  const name = packageNameOfSpecifier(specifier);
  if (!BUILTIN_ALIAS_PACKAGES.has(name)) return null;
  const dir = installedPackageDir(fromFile, name);
  if (dir === null) return null;
  const text = trackedReadFile(join(dir, "package.json"));
  if (text === null) return null;
  let pkg: { name?: unknown; version?: unknown };
  try {
    pkg = JSON.parse(text) as { name?: unknown; version?: unknown };
  } catch {
    return null;
  }
  if (pkg.name !== name || typeof pkg.version !== "string") return null;
  return builtinAliasOf(name, pkg.version, specifier.slice(name.length).replace(/^\//, ""));
}

/** True when a bare specifier is served by a shim or marked unloaded: it is
 * not an npm import for the npm-static machinery. */
export function isShimmedImport(fromFile: string, specifier: string): boolean {
  return isUnloadedPackage(specifier) || packageShimFor(fromFile, specifier) !== null;
}

/** The shimmed package whose declaration entry `path` is, with the
 * package directory: `<pkg>/index.d.ts`, or the entry's own `typesFile`. */
function shimOfDeclarationPath(path: string): { pkgDir: string; shim: ImplementationShim } | null {
  if (!/\.d\.[cm]?ts$/.test(path)) return null;
  if (path.endsWith("/index.d.ts")) {
    const pkgDir = dirname(path);
    const shim = IMPLEMENTATION_SHIMS.get(pkgDir.slice(pkgDir.lastIndexOf("/") + 1));
    if (shim !== undefined && shim.typesFile === undefined) return { pkgDir, shim };
  }
  for (const shim of IMPLEMENTATION_SHIMS.values()) {
    if (shim.typesFile === undefined) continue;
    const suffix = `/${shim.name}/${shim.typesFile}`;
    if (path.endsWith(suffix))
      return { pkgDir: path.slice(0, path.length - suffix.length + shim.name.length + 1), shim };
  }
  return null;
}

/** The fs-shadow answer for a shimmed package's declaration entry: the
 * installed `index.d.ts` reads as a re-export of the version's shim module,
 * so the checker types each importer against its own version. Undefined
 * for every other path. */
export function packageShimDeclarationText(path: string): string | undefined {
  const located = shimOfDeclarationPath(path);
  if (located === null) return undefined;
  const { pkgDir, shim } = located;
  const name = shim.name;
  // A DefinitelyTyped twin (`@types/fs-extra`) types a package that ships no
  // declarations. Nothing at its path names the installed runtime version,
  // so it reads as the shim only when every supported version shares one
  // module.
  const viaTypes = dirname(pkgDir).endsWith("/@types");
  const entries = new Set(shim.versions.values());
  const entry = viaTypes
    ? entries.size === 1
      ? join(packageShimRoot(), [...entries][0]!)
      : null
    : shimEntryForPackageDir(pkgDir, name);
  if (entry === null) return undefined;
  const target = JSON.stringify(tsgoPath(entry));
  const defaultLine = shim.defaultExport === true ? `export { default } from ${target};\n` : "";
  return `// scriptc: this package compiles from its built-in implementation.\nexport * from ${target};\n${defaultLine}`;
}

/** True for a file of the shipped package shims. They are compiler-owned
 * implementations, type-checked by scriptc's own tests: like library
 * declarations under skipLibCheck, a project's lib and @types/node choice
 * must not turn their internals into the project's type errors. */
export function isPackageShimFile(fileName: string): boolean {
  const root = tsgoPath(packageShimRoot());
  return fileName.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** True for a name a shipped shim may declare as a bodiless runtime
 * intrinsic (lower-calls.ts lowers its calls to runtime calls). */
export function isShimIntrinsicName(name: string): boolean {
  return name.startsWith("scriptcUnixDgram") || name === "scriptcResponseLight";
}

/** Resets per-compile caches. */
export function clearPackageShimCaches(): void {
  installedCache.clear();
  bundledForwarders.clear();
}
