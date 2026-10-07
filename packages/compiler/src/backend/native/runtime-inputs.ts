import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MBEDTLS_VERSION, QJS_COMMIT, ZLIB_VERSION } from "../vendor-inputs.js";
import { stableTestMemo } from "./session.js";

const implementationPath = fileURLToPath(import.meta.url);
const backendDir = dirname(dirname(implementationPath));

/** Recipe bytes and dependency snapshots must cover every extracted owner in
 * both source and installed builds. Keep this explicit: directory enumeration
 * could accidentally hash tests, source maps, or stale installed modules. */
export const NATIVE_RECIPE_IMPLEMENTATION_PATHS = [
  "native-toolchain",
  "build-cache",
  "vendor-archives",
  "native/process",
  "native/runtime-inputs",
  "native/session",
  "native/driver",
  "native/tool-identity",
  "native/contracts",
  "native/program-shards",
  "native/library",
  "native/object-merge",
  "native/compiler-fingerprint",
  "native/linker-fingerprint",
  "native/dependency-files",
  "native/trace-paths",
  "native/runtime-objects",
  "native/vendor",
  "native/artifact-stamps",
  "native/executable",
  "native/cache-warm",
].map((stem) => join(backendDir, `${stem}${extname(implementationPath)}`));

export const EXECUTABLE_RUNTIME_SOURCES = [
  "scr_context.c",
  "scr_shared.c",
  "scr_number.c",
  "scr_bigint.c",
  "scr_string.c",
  "scr_grapheme.c",
  "scr_array.c",
  "scr_bytes.c",
  "scr_bytes_io.c",
  "scr_map.c",
  "scr_closure.c",
  "scr_ffi.c",
  "scr_object.c",
  "scr_union.c",
  "scr_exception.c",
  "scr_error.c",
  "scr_console.c",
  "scr_lib.c",
  "scr_path.c",
  "scr_url.c",
  "scr_url_params.c",
  "scr_json.c",
  "scr_node_builtin.c",
  "scr_async.c",
  "scr_crypto_async.c",
  "scr_child.c",
  "scr_cycle.c",
] as const;

export function runtimeSrcDir(): string {
  const testRoot = process.env["SCRIPTC_TEST_RUNTIME_SRC_DIR"];
  if (testRoot !== undefined) return resolve(testRoot);
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@scriptc/runtime/package.json")), "src");
}

/** The library base: the executable lane's unconditional sources minus the
 * fiber/loop and child-process units, plus the library-mode TU. */
export const LIB_RUNTIME_SOURCES = [
  ...EXECUTABLE_RUNTIME_SOURCES.filter(
    (f) =>
      f !== "scr_async.c" && f !== "scr_crypto_async.c" && f !== "scr_child.c" && f !== "scr_ffi.c",
  ),
  "scr_library.c",
];

export async function nativeSourceFiles(
  directory: string,
  recursive: boolean,
  include: (name: string) => boolean = (name) => name.endsWith(".c") || name.endsWith(".h"),
): Promise<string[]> {
  const files: string[] = [];
  const walk = async (current: string, ancestors: ReadonlySet<string>): Promise<void> => {
    const canonical = await realpath(current).catch(() => resolve(current));
    if (ancestors.has(canonical)) return;
    const nestedAncestors = new Set(ancestors).add(canonical);
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory() && recursive) {
        await walk(path, nestedAncestors);
      } else if (entry.isSymbolicLink()) {
        const target = await stat(path).catch(() => null);
        if (target?.isDirectory() && recursive) await walk(path, nestedAncestors);
        else if (target?.isFile() && include(entry.name)) files.push(path);
      } else if (entry.isFile() && include(entry.name)) {
        files.push(path);
      }
    }
  };
  await walk(directory, new Set());
  return files.sort();
}

/** Content hash of every owned native source/header plus this backend's build
 * recipe implementation. It keys complete artifacts, runtime objects, and the
 * separately built vendor prerequisites, so two installed scriptc versions or
 * worktrees can share a user cache without exchanging outputs produced from
 * different vendored bytes or compile/archive recipes. Recursive enumeration
 * also catches a newly added nested header that begins shadowing a system
 * include, while content hashing catches same-size timestamp-preserving edits. */
async function runtimeFingerprintFresh(rtDir: string): Promise<string> {
  const groups = await runtimeFingerprintInputGroups(rtDir);
  const h = createHash("sha256")
    .update("native-owned-inputs-v2\0")
    .update(QJS_COMMIT)
    .update(MBEDTLS_VERSION)
    .update(ZLIB_VERSION)
    .update("\0backend-recipe\0");
  for (const path of NATIVE_RECIPE_IMPLEMENTATION_PATHS) {
    h.update(basename(path))
      .update("\0")
      .update(await readFile(path))
      .update("\0");
  }
  for (const group of groups) {
    for (const n of group.names) {
      h.update(group.label)
        .update("/")
        .update(n)
        .update("\0")
        .update(await readFile(join(group.dir, n)))
        .update("\0");
    }
  }
  return h.digest("hex");
}

async function runtimeFingerprintInputGroups(
  rtDir: string,
): Promise<{ label: string; dir: string; names: string[] }[]> {
  return Promise.all(
    [
      { label: "runtime", dir: rtDir },
      { label: "ryu", dir: join(rtDir, "..", "vendor", "ryu") },
      { label: "quickjs-ng", dir: join(rtDir, "..", "vendor", "quickjs-ng") },
      { label: "mbedtls", dir: join(rtDir, "..", "vendor", "mbedtls") },
      { label: "zlib", dir: join(rtDir, "..", "vendor", "zlib") },
      { label: "curl", dir: join(rtDir, "..", "vendor", "curl") },
    ].map(async (group) => {
      const names = (await nativeSourceFiles(group.dir, true))
        .map((path) => relative(group.dir, path))
        .sort();
      return { ...group, names };
    }),
  );
}

export async function runtimeFingerprintInputPaths(rtDir: string): Promise<string[]> {
  return [
    ...(await runtimeFingerprintInputGroups(rtDir)).flatMap((group) =>
      group.names.map((name) => join(group.dir, name)),
    ),
    ...NATIVE_RECIPE_IMPLEMENTATION_PATHS,
  ];
}

const stableRuntimeFingerprintMemos = new Map<string, Promise<string>>();
export function runtimeFingerprint(rtDir: string): Promise<string> {
  const key = resolve(rtDir);
  return stableTestMemo(stableRuntimeFingerprintMemos, key, () => runtimeFingerprintFresh(rtDir));
}
