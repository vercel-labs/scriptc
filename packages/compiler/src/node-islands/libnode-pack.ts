/* The installed libnode packs (scope-B design §2.11, §2.13, §2.16.3):
 * `@scriptc/libnode-<platform>`, built only by the libnode-packs workflow
 * from the pinned Node release (packages/libnode-common) and installed like
 * the runtime packs. A scriptc build never compiles Node.
 *
 * libnode.ts decides which pack a build records: --libnode, else
 * SCRIPTC_LIBNODE, else the installed pack this module finds: the nearest
 * `node_modules/@scriptc/libnode-<platform>` walking up from the project
 * directory, else the one next to the compiler. The manifest format is the
 * one packages/libnode-common/build-pack.mjs writes (schema, nodeVersion,
 * moduleVersion, bridgeAbi, platform, arch, libnode, bridge, files); the
 * published packs add package, version, target, license and build inputs.
 *
 * Also here: the `nodeIslands.libnode` setting ("embedded" | "beside" |
 * <absolute directory>) for the project configuration, and the license
 * notices a program that redistributes Node.js carries. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const LIBNODE_PACK_SCHEMA = "scriptc.libnode-pack.v1";

/** The pack package for each native target that can host Node islands. */
const PACK_PACKAGES: Readonly<Record<string, string>> = {
  "linux-x64-gnu": "@scriptc/libnode-linux-x64-gnu",
  "linux-arm64-gnu": "@scriptc/libnode-linux-arm64-gnu",
  "macos-arm64": "@scriptc/libnode-darwin-arm64",
  "macos-x64": "@scriptc/libnode-darwin-x64",
};

export type LibnodePlacement =
  | { kind: "embedded" }
  | { kind: "beside" }
  | { kind: "path"; path: string };

export interface LibnodeFile {
  size: number;
  sha256: string;
}

export interface LibnodePackManifest {
  schema: string;
  nodeVersion: string;
  moduleVersion: number;
  bridgeAbi: number;
  /** process.platform and process.arch of the pack. */
  platform: string;
  arch: string;
  /** File names inside the pack directory. */
  libnode: string;
  bridge: string;
  files: Record<string, LibnodeFile>;
  /** Published packs only. */
  package?: string;
  version?: string;
  target?: string;
  license?: string;
}

export interface LibnodePack {
  root: string;
  manifest: LibnodePackManifest;
}

export class LibnodePackError extends Error {
  readonly kind: "missing" | "invalid" | "unsupported";

  constructor(message: string, kind: "missing" | "invalid" | "unsupported") {
    super(message);
    this.name = "LibnodePackError";
    this.kind = kind;
  }
}

/** The libnode pack package for a native target, or null when Node islands
 * have no pack there (musl, Windows, WASI and mobile targets). */
export function libnodePackPackage(targetName: string): string | null {
  return PACK_PACKAGES[targetName] ?? null;
}

/** The native target name of the host, as libnodePackPackage takes it. */
export function hostLibnodeTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return platform === "darwin" ? `macos-${arch}` : `${platform}-${arch}-gnu`;
}

/** Validates a `nodeIslands.libnode` value; a string result is the reason
 * it is invalid. */
export function parseLibnodeSetting(value: unknown): LibnodePlacement | string {
  if (value === "embedded") return { kind: "embedded" };
  if (value === "beside") return { kind: "beside" };
  if (typeof value === "string" && isAbsolute(value)) return { kind: "path", path: value };
  if (typeof value === "string") {
    return `must be "embedded", "beside" or an absolute directory, not the relative path "${value}"`;
  }
  return `must be "embedded", "beside" or an absolute directory`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFileEntry(value: unknown): value is LibnodeFile {
  return (
    isRecord(value) &&
    typeof value["size"] === "number" &&
    typeof value["sha256"] === "string" &&
    /^[0-9a-f]{64}$/.test(value["sha256"])
  );
}

/** Parses a pack's manifest.json; throws LibnodePackError when it is not a
 * pack manifest. Bridge ABI and Node version policy stay in libnode.ts. */
export function parseLibnodePackManifest(json: unknown, where: string): LibnodePackManifest {
  const invalid = (detail: string): never => {
    throw new LibnodePackError(`the libnode pack at ${where} ${detail}`, "invalid");
  };
  if (!isRecord(json)) return invalid("has a malformed manifest.json");
  if (json["schema"] !== LIBNODE_PACK_SCHEMA) {
    return invalid(
      `has manifest schema ${String(json["schema"])}, expected ${LIBNODE_PACK_SCHEMA}`,
    );
  }
  for (const field of ["nodeVersion", "platform", "arch", "libnode", "bridge"]) {
    if (typeof json[field] !== "string" || json[field] === "") {
      return invalid(`has no ${field} in manifest.json`);
    }
  }
  if (typeof json["moduleVersion"] !== "number" || typeof json["bridgeAbi"] !== "number") {
    return invalid("has no moduleVersion or bridgeAbi in manifest.json");
  }
  const files = json["files"];
  if (!isRecord(files)) return invalid("lists no files in manifest.json");
  for (const name of [json["libnode"], json["bridge"]] as string[]) {
    if (name === "." || name === ".." || /[/\\\0]/.test(name) || isAbsolute(name)) {
      return invalid(`names a file outside the pack (${JSON.stringify(name)})`);
    }
    if (!isFileEntry(files[name])) return invalid(`lists no size and SHA-256 for ${name}`);
  }
  return json as unknown as LibnodePackManifest;
}

/** Reads and checks the pack in `root`: its manifest, its package when
 * `packageName` is given, and that each library exists with the recorded
 * size (and SHA-256 when `verifyHashes`). */
export function readLibnodePack(
  root: string,
  options: { packageName?: string | undefined; verifyHashes?: boolean | undefined } = {},
): LibnodePack {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  } catch {
    throw new LibnodePackError(
      `no libnode pack at ${root} (manifest.json is missing or unreadable)`,
      "missing",
    );
  }
  const manifest = parseLibnodePackManifest(json, root);
  if (options.packageName !== undefined && manifest.package !== options.packageName) {
    throw new LibnodePackError(
      `the libnode pack at ${root} is ${manifest.package ?? "unnamed"}; this target needs ${options.packageName}`,
      "invalid",
    );
  }
  for (const name of [manifest.libnode, manifest.bridge]) {
    const path = join(root, name);
    const entry = manifest.files[name]!;
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      throw new LibnodePackError(`the libnode pack at ${root} is missing ${name}`, "invalid");
    }
    const hashMismatch =
      options.verifyHashes === true &&
      createHash("sha256").update(readFileSync(path)).digest("hex") !== entry.sha256;
    if (size !== entry.size || hashMismatch) {
      throw new LibnodePackError(
        `${name} in the libnode pack at ${root} does not match its manifest`,
        "invalid",
      );
    }
  }
  return { root, manifest };
}

/** The nearest `node_modules/<name>` directory with a built pack (a
 * manifest.json) walking up from `from`. */
function findInstalled(name: string, from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "manifest.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveNextToCompiler(name: string): string | null {
  try {
    const dir = dirname(createRequire(import.meta.url).resolve(`${name}/package.json`));
    // An unbuilt workspace package is not a pack.
    return existsSync(join(dir, "manifest.json")) ? dir : null;
  } catch {
    return null;
  }
}

/** The installed pack directory for `targetName`, or null when none is
 * installed or the target has no packs. */
export function findInstalledLibnodePack(options: {
  targetName: string;
  projectDir: string;
  /** Test hook for the compiler-relative lookup. */
  resolveInstalled?: ((name: string) => string | null) | undefined;
}): string | null {
  const packageName = libnodePackPackage(options.targetName);
  if (packageName === null) return null;
  return (
    findInstalled(packageName, options.projectDir) ??
    (options.resolveInstalled ?? resolveNextToCompiler)(packageName)
  );
}

/** Writes the license notices a program that redistributes Node.js must
 * carry, `<output>.licenses.txt` (design §2.13), and returns its path. */
export function writeLibnodeNotices(pack: LibnodePack, outPath: string): string {
  const { manifest } = pack;
  const nodeLicense = readFileSync(join(pack.root, manifest.license ?? "LICENSE"), "utf8");
  const origin =
    manifest.package !== undefined && manifest.version !== undefined
      ? ` (${manifest.package}@${manifest.version})`
      : "";
  const path = `${outPath}.licenses.txt`;
  writeFileSync(
    path,
    [
      `${basename(outPath)} runs part of its code in Node.js ${manifest.nodeVersion}, loaded from ${manifest.libnode}${origin}.`,
      `Node.js and the components it bundles are licensed as follows. The scriptc bridge,`,
      `${manifest.bridge}, is licensed under Apache-2.0.`,
      "",
      nodeLicense.trimEnd(),
      "",
    ].join("\n"),
  );
  return path;
}
