/* Polyfill packages whose behavior on Node 24 IS a Node builtin. The
 * package-shim registry (package-shims.ts) consults this table: a require
 * of such a package, from an installed copy's importer or through a bundled
 * __commonJS chunk whose path names the package, compiles as the builtin
 * expression its module evaluates to on Node 24, at the require's position
 * (loading a builtin runs no code, and none of these packages has an
 * observable side effect at load).
 *
 * Each entry names the major versions whose entry modules were checked:
 *
 * - isarray 0.x, 1.x, 2.x: `module.exports = Array.isArray || function …`;
 *   Node always has Array.isArray, so the export is Array.isArray itself.
 * - safe-buffer 5.x: `module.exports = buffer` when Buffer.from, alloc,
 *   allocUnsafe and allocUnsafeSlow exist (Node 6 and later); the rest of
 *   the module only builds its unexported SafeBuffer fallback.
 * - process-nextick-args 2.x: `module.exports = process` unless
 *   process.version is v0.x or a pre-1.8 v1.x.
 * - inherits 2.x: inherits.js exports require("util").inherits (2.0.1
 *   directly, 2.0.3 and later whenever it is a function, always on Node).
 * - util-deprecate 1.x: node.js (its Node entry) is
 *   `module.exports = require("util").deprecate`.
 * - readable-stream 2.x, 3.x, 4.x: a documented divergence. The package
 *   ships a JavaScript copy of Node's streams; its READABLE_STREAM=disable
 *   behavior hands out Node's own stream classes instead, and that is what
 *   compiles:
 *   - 2.x readable.js exports stream.Readable carrying Readable, Writable,
 *     Duplex, Transform, PassThrough and Stream; writable.js exports
 *     stream.Writable and duplex/transform/passthrough.js read the entry;
 *   - 3.x (a copy of Node 10's streams) readable.js exports the same
 *     members plus finished and pipeline. Its own disable branch throws on
 *     Node 24 (it Object.assigns every stream export onto stream.Readable,
 *     which inherits the getter-only `promises` accessor), so 3.x maps the
 *     members its default branch exports onto the builtin's;
 *   - 4.x lib/ours/index.js exports a plain object of named stream exports.
 *   The lib/_stream_*.js implementation files map to the matching builtin
 *   classes as well (Node itself loads the package's JavaScript
 *   implementations through them, whatever the environment). Without the
 *   variable Node runs the package's own JavaScript streams. */

export interface BuiltinAlias {
  /** The expression the module's export evaluates to, or null when only
   * its member reads have a builtin spelling. */
  whole: string | null;
  /** For an export that carries another object's members (readable-stream's
   * entry): member reads of these names read `object`'s members. */
  members?: { object: string; names: ReadonlySet<string> };
}

const STREAM_CLASSES = ["Readable", "Writable", "Duplex", "Transform", "PassThrough"];

/** The members readable-stream 4.x's entry copies from `stream` under
 * READABLE_STREAM=disable. */
const RS4_ENTRY_EXPORTS = [
  "_uint8ArrayToBuffer",
  "_isUint8Array",
  "isDisturbed",
  "isErrored",
  "isReadable",
  ...STREAM_CLASSES,
  "addAbortSignal",
  "finished",
  "destroy",
  "pipeline",
  "compose",
  "Stream",
];

function majorOf(version: string): number {
  return Number(/^(\d+)\./.exec(version)?.[1] ?? Number.NaN);
}

function stripJs(subpath: string): string {
  return subpath.replace(/^\.\//, "").replace(/\.js$/, "");
}

/** The builtin a package module is on Node 24, or null. `subpath` is the
 * file inside the package ("" for its main entry). */
export function builtinAliasOf(pkg: string, version: string, subpath: string): BuiltinAlias | null {
  const major = majorOf(version);
  const file = stripJs(subpath);
  switch (pkg) {
    case "isarray":
      return (major === 0 || major === 1 || major === 2) && (file === "" || file === "index")
        ? { whole: "Array.isArray" }
        : null;
    case "safe-buffer":
      return major === 5 && (file === "" || file === "index")
        ? { whole: 'require("buffer")' }
        : null;
    case "process-nextick-args":
      return major === 2 && (file === "" || file === "index") ? { whole: "process" } : null;
    case "inherits":
      return major === 2 && (file === "" || file === "inherits")
        ? { whole: 'require("util").inherits' }
        : null;
    case "util-deprecate":
      return major === 1 && (file === "" || file === "node")
        ? { whole: 'require("util").deprecate' }
        : null;
    case "readable-stream": {
      if (major !== 2 && major !== 3 && major !== 4) return null;
      const stream = 'require("stream")';
      const entry = major === 4 ? file === "lib/ours/index" : file === "readable";
      if (file === "" || entry) {
        if (major === 4)
          return { whole: null, members: { object: stream, names: new Set(RS4_ENTRY_EXPORTS) } };
        const names = new Set([
          ...STREAM_CLASSES,
          "Stream",
          ...(major === 3 ? ["finished", "pipeline"] : []),
        ]);
        return { whole: `${stream}.Readable`, members: { object: stream, names } };
      }
      for (const cls of STREAM_CLASSES) {
        const lower = cls.toLowerCase();
        if (file === `lib/_stream_${lower}` || (major === 2 && file === lower))
          return { whole: `${stream}.${cls}` };
      }
      return null;
    }
    default:
      return null;
  }
}

/** Package names the table can alias (a cheap pre-filter). */
export const BUILTIN_ALIAS_PACKAGES: ReadonlySet<string> = new Set([
  "isarray",
  "safe-buffer",
  "process-nextick-args",
  "inherits",
  "util-deprecate",
  "readable-stream",
]);

/** The package, version and in-package file a bundler's module key names
 * when it carries a version (pnpm's `node_modules/.pnpm/<name>@<version>/
 * node_modules/<name>/<file>`), or null. */
export function versionedPackageOfKey(
  key: string,
): { name: string; version: string; subpath: string } | null {
  const m =
    /(?:^|\/)node_modules\/\.pnpm\/((?:@[^/+]+\+)?[^/@]+)@([^/_]+)[^/]*\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(.+)$/.exec(
      key,
    );
  if (m === null) return null;
  const [, storeName, version, name, subpath] = m;
  if (storeName!.replace("+", "/") !== name) return null;
  return { name: name!, version: version!, subpath: subpath! };
}
