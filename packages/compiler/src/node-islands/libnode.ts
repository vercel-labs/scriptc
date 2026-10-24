/* The libnode pack a program with Node islands loads Node from (scope-B
 * design §2.11, §2.13, §2.16). The build reads the pack's manifest and
 * records the pack directory and its Node version into the executable;
 * the executable loads that pack on its first call into Node, checks that
 * its bridge links exactly that Node, and never searches for another.
 * SCRIPTC_LIBNODE overrides the recorded directory at run time.
 *
 * Where the build finds the pack: `--libnode=<pack directory>`, else
 * SCRIPTC_LIBNODE in the build's environment, else the installed
 * @scriptc/libnode-<platform> pack (libnode-pack.ts).
 * `--libnode=beside` takes that pack and copies it next to the executable
 * as `<output>.libnode/`, recorded as `$ORIGIN/<output>.libnode`, so the
 * executable and its Node travel together; a recorded `$ORIGIN/` path is
 * also the hook for bundling Node into the executable itself later. */
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { compilerReleaseVersion } from "../library/sidecar.js";
import { nativeCodegenTarget } from "../backend/targets.js";
import {
  findInstalledLibnodePack,
  hostLibnodeTarget,
  LibnodePackError,
  libnodePackPackage,
  readLibnodePack,
  type LibnodePack,
} from "./libnode-pack.js";

/** The oldest Node.js release Node islands support: synchronous
 * module.registerHooks, which shared modules need, is a release candidate
 * from here on (decision 5). */
export const NODE_ISLAND_MIN_NODE = "24.13.1";

/** The bridge ABI this compiler's runtime speaks (scr_node_bridge.h). */
export const NODE_BRIDGE_ABI = 3;

/** The prefix of a recorded path relative to the executable's directory. */
export const ORIGIN = "$ORIGIN/";

export interface LibnodeRecord {
  /** The pack directory: absolute, or `$ORIGIN/`-relative. */
  libnode: string;
  /** The exact Node version the pack's bridge links. */
  nodeVersion: string;
}

interface PackManifest {
  nodeVersion: string;
  bridgeAbi: number;
  files: Record<string, unknown>;
}

function versionAtLeast(version: string, floor: string): boolean {
  const a = version.split(".").map(Number);
  const b = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

function readManifest(dir: string): PackManifest | string {
  let manifest: Partial<PackManifest>;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as PackManifest;
  } catch {
    return `no libnode pack at ${dir} (manifest.json is missing or unreadable)`;
  }
  if (typeof manifest.nodeVersion !== "string" || typeof manifest.bridgeAbi !== "number")
    return `the libnode pack at ${dir} has a malformed manifest.json`;
  if (manifest.bridgeAbi !== NODE_BRIDGE_ABI)
    return `the libnode pack at ${dir} has bridge ABI ${manifest.bridgeAbi}; this scriptc needs ${NODE_BRIDGE_ABI}`;
  if (!versionAtLeast(manifest.nodeVersion, NODE_ISLAND_MIN_NODE))
    return `the libnode pack at ${dir} is Node ${manifest.nodeVersion}; Node islands need Node.js >=${NODE_ISLAND_MIN_NODE}`;
  return {
    nodeVersion: manifest.nodeVersion,
    bridgeAbi: manifest.bridgeAbi,
    files: manifest.files ?? {},
  };
}

/** Copies the pack next to the executable (hard links where possible), or
 * returns why it cannot: the target would replace the pack itself, the
 * manifest names a file outside the pack, or a pack file is not a regular
 * file (a symbolic link could point anywhere). Every destination is checked
 * to resolve inside the target directory. */
function placeBeside(source: string, manifest: PackManifest, target: string): string | undefined {
  const names = ["manifest.json", "LICENSE", ...Object.keys(manifest.files)];
  const unsafe = names.find(
    (name) =>
      name === "" || name === "." || name === ".." || /[/\\\0]/.test(name) || isAbsolute(name),
  );
  if (unsafe !== undefined)
    return `the libnode pack at ${source} lists a file outside the pack ('${unsafe}')`;
  const from = realpathOr(source);
  const to = realpathOr(target);
  if (from === to || from.startsWith(to + sep) || to.startsWith(from + sep))
    return `--libnode=beside would replace the libnode pack it copies (${source}); point SCRIPTC_LIBNODE at a pack outside ${target}`;
  const present: string[] = [];
  for (const name of names) {
    let info;
    try {
      info = lstatSync(join(source, name));
    } catch {
      continue;
    }
    if (!info.isFile())
      return `the libnode pack at ${source} holds ${name} as a ${info.isSymbolicLink() ? "symbolic link" : "non-regular file"}; pack files must be regular files`;
    present.push(name);
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const inside = resolve(target) + sep;
  for (const name of present) {
    const destination = resolve(target, name);
    if (!destination.startsWith(inside))
      return `the libnode pack at ${source} lists a file outside the pack ('${name}')`;
    const file = join(source, name);
    try {
      linkSync(file, destination);
    } catch {
      copyFileSync(file, destination, constants.COPYFILE_EXCL);
    }
  }
  return undefined;
}

/** The canonical path of `path`, or `path` resolved when it does not exist. */
function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The native target whose libnode pack a build records: the codegen
 * target (SCRIPTC_TARGET, and the host's libc), else the host. */
export function libnodeTarget(env: NodeJS.ProcessEnv = process.env): string {
  return nativeCodegenTarget(env)?.name ?? hostLibnodeTarget();
}

/** Why the installed pack in `dir` cannot serve this compiler, or null: it
 * must be the target's package at the compiler's own version. */
function installedPackProblem(dir: string, packageName: string): string | null {
  let pack: LibnodePack;
  try {
    // An installed pack is found, not named: check its files' digests too.
    pack = readLibnodePack(dir, { packageName, verifyHashes: true });
  } catch (error) {
    return error instanceof LibnodePackError ? error.message : String(error);
  }
  const version = compilerReleaseVersion();
  if (pack.manifest.version !== version)
    return `the installed libnode pack ${packageName} at ${dir} is version ${pack.manifest.version ?? "unknown"}; this scriptc is ${version}: install ${packageName}@${version}`;
  return null;
}

/** What to record for a program that calls into Node, or the reason the
 * build cannot (an SC8005 message). `option` is --libnode. */
export function libnodeRecord(
  option: string | undefined,
  outPath: string,
  env: NodeJS.ProcessEnv = process.env,
  projectDir: string = process.cwd(),
): LibnodeRecord | string {
  const fromEnv = env["SCRIPTC_LIBNODE"];
  const beside = option === "beside";
  const explicit = option !== undefined && !beside ? option : fromEnv;
  const target = libnodeTarget(env);
  // Without an explicit pack, the installed @scriptc/libnode-<target>.
  const installed =
    explicit !== undefined && explicit !== ""
      ? null
      : findInstalledLibnodePack({ targetName: target, projectDir });
  const source = installed ?? explicit;
  if (source === undefined || source === null || source === "") {
    const pack = libnodePackPackage(target);
    return pack === null
      ? `this program calls into Node.js (@scriptc/node), but there is no libnode pack for ${target}: set SCRIPTC_LIBNODE or pass --libnode=<pack directory>`
      : `this program calls into Node.js (@scriptc/node), but no libnode pack is installed: install ${pack}, set SCRIPTC_LIBNODE or pass --libnode=<pack directory>`;
  }
  if (installed !== null) {
    const problem = installedPackProblem(installed, libnodePackPackage(target)!);
    if (problem !== null) return problem;
  }
  if (source.startsWith(ORIGIN)) {
    // A pack the deployment places next to the executable: nothing to read.
    return { libnode: source, nodeVersion: "" };
  }
  if (!isAbsolute(source)) return `the libnode pack directory must be absolute, got '${source}'`;
  const manifest = readManifest(source);
  if (typeof manifest === "string") return manifest;
  if (!beside) return { libnode: resolve(source), nodeVersion: manifest.nodeVersion };
  const name = `${basename(outPath)}.libnode`;
  const refused = placeBeside(source, manifest, `${outPath}.libnode`);
  if (refused !== undefined) return refused;
  return { libnode: `${ORIGIN}${name}`, nodeVersion: manifest.nodeVersion };
}

/** The identity of the libnode pack a build that calls into Node.js
 * records, which the program's executable cache entry keeps
 * (EarlyExecutableCacheOptions.libnodeIdentity): the option, the pack
 * directory (named by --libnode or SCRIPTC_LIBNODE, or the installed pack
 * found from `projectDir`), and a digest of the pack's manifest.json. A pack
 * upgraded in place, removed, or replaced by another installed pack changes
 * it. Undefined when no pack is named or installed. */
export function libnodeCacheKey(
  option: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  projectDir: string = process.cwd(),
): string | undefined {
  const fromEnv = env["SCRIPTC_LIBNODE"];
  const explicit = option !== undefined && option !== "beside" ? option : fromEnv;
  const source =
    explicit !== undefined && explicit !== ""
      ? explicit
      : findInstalledLibnodePack({ targetName: libnodeTarget(env), projectDir });
  if (source === undefined || source === null) return option === undefined ? undefined : option;
  let manifest = "none";
  if (isAbsolute(source)) {
    try {
      manifest = createHash("sha256")
        .update(readFileSync(join(source, "manifest.json")))
        .digest("hex");
    } catch {
      // A missing pack fails the build that records it (libnodeRecord).
    }
  }
  return `${option ?? ""}|${source}|${manifest}`;
}
