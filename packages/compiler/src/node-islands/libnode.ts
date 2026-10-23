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
import { copyFileSync, linkSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { findInstalledLibnodePack, hostLibnodeTarget, libnodePackPackage } from "./libnode-pack.js";

/** The oldest Node.js release Node islands support: synchronous
 * module.registerHooks, which shared modules need, is a release candidate
 * from here on (decision 5). */
export const NODE_ISLAND_MIN_NODE = "24.13.1";

/** The bridge ABI this compiler's runtime speaks (scr_node_bridge.h). */
export const NODE_BRIDGE_ABI = 9;

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

/** Copies the pack next to the executable (hard links where possible). */
function placeBeside(source: string, manifest: PackManifest, target: string): void {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const name of ["manifest.json", "LICENSE", ...Object.keys(manifest.files)]) {
    const from = join(source, name);
    try {
      statSync(from);
    } catch {
      continue;
    }
    try {
      linkSync(from, join(target, name));
    } catch {
      copyFileSync(from, join(target, name));
    }
  }
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
  // Without an explicit pack, the installed @scriptc/libnode-<platform>.
  const source =
    explicit !== undefined && explicit !== ""
      ? explicit
      : findInstalledLibnodePack({ targetName: hostLibnodeTarget(), projectDir });
  if (source === undefined || source === null || source === "")
    return `this program calls into Node.js (@scriptc/node), but no libnode pack is installed: install ${libnodePackPackage(hostLibnodeTarget()) ?? "a libnode pack"}, set SCRIPTC_LIBNODE or pass --libnode=<pack directory>`;
  if (source.startsWith(ORIGIN)) {
    // A pack the deployment places next to the executable: nothing to read.
    return { libnode: source, nodeVersion: "" };
  }
  if (!isAbsolute(source)) return `the libnode pack directory must be absolute, got '${source}'`;
  const manifest = readManifest(source);
  if (typeof manifest === "string") return manifest;
  if (!beside) return { libnode: resolve(source), nodeVersion: manifest.nodeVersion };
  const name = `${basename(outPath)}.libnode`;
  placeBeside(source, manifest, `${outPath}.libnode`);
  return { libnode: `${ORIGIN}${name}`, nodeVersion: manifest.nodeVersion };
}

/** The part of an executable's cache key that names its libnode pack, or
 * undefined when neither --libnode nor SCRIPTC_LIBNODE is set. It holds the
 * option, the pack directory and a digest of the pack's manifest.json, so
 * that a pack upgraded in place (another Node version, bridge ABI or file
 * list) gives cached executables a new key instead of their old record.
 * An installed @scriptc/libnode-<platform> pack needs no part: it versions
 * in lockstep with the compiler, whose version every key already holds, so
 * the bootstrap's routed cache keeps serving builds where one is installed. */
export function libnodeCacheKey(
  option: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = env["SCRIPTC_LIBNODE"];
  if (option === undefined && fromEnv === undefined) return undefined;
  const source = option !== undefined && option !== "beside" ? option : (fromEnv ?? "");
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

/** The libnode pack directory the build-time probe of deferred islands
 * runs in (scope-B NI-7): the same pack libnodeRecord records (before a
 * `beside` copy), or null when the build host has none to run. */
export function libnodeProbePack(
  option: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  projectDir: string = process.cwd(),
): string | null {
  const fromEnv = env["SCRIPTC_LIBNODE"];
  const explicit = option !== undefined && option !== "beside" ? option : fromEnv;
  const source =
    explicit !== undefined && explicit !== ""
      ? explicit
      : findInstalledLibnodePack({ targetName: hostLibnodeTarget(), projectDir });
  if (source === undefined || source === null || source === "" || !isAbsolute(source)) return null;
  return typeof readManifest(source) === "string" ? null : resolve(source);
}
