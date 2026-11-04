import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { nativeArtifactDependenciesStillMatch } from "./artifact-stamps.js";
import { type NativeArtifactDependency } from "./contracts.js";

const RECORD_VERSION = 1;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
/** The record is a few hundred bytes; anything larger is not one. */
const MAX_RECORD_LENGTH = 64 * 1024;

interface HelperIdentityRecord {
  version: typeof RECORD_VERSION;
  binary: string;
  digest: string;
  dependencies: NativeArtifactDependency[];
}

function identityRecordPath(packageRoot: string): string {
  return join(packageRoot, ".scriptc", "identity.json");
}

/** The helper binary's package-relative path, in the form the record stores. */
function recordBinaryName(packageRoot: string, binaryPath: string): string {
  return relative(packageRoot, binaryPath).split(sep).join("/");
}

function isRecord(value: unknown): value is HelperIdentityRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<HelperIdentityRecord>;
  return (
    record.version === RECORD_VERSION &&
    typeof record.binary === "string" &&
    typeof record.digest === "string" &&
    DIGEST_PATTERN.test(record.digest) &&
    Array.isArray(record.dependencies)
  );
}

/** The digest this install recorded for its helper, or null when the record is
 * absent, unreadable, or no longer proves these exact installed files. The
 * caller hashes the binary in that case; this only skips the 57 MiB read and
 * hash once the recorded filesystem proof still holds. */
export async function readHelperIdentityDigest(
  packageJsonPath: string,
  binaryPath: string,
  dependencies: readonly NativeArtifactDependency[],
): Promise<string | null> {
  try {
    const packageRoot = dirname(packageJsonPath);
    const text = await readFile(identityRecordPath(packageRoot), "utf8");
    if (text.length > MAX_RECORD_LENGTH) return null;
    const record: unknown = JSON.parse(text);
    if (!isRecord(record)) return null;
    if (record.binary !== recordBinaryName(packageRoot, binaryPath)) return null;
    // The record must describe the very snapshot that keys this build's cache
    // entries, and those files must still be the ones on disk.
    if (
      JSON.stringify(record.dependencies) !== JSON.stringify(dependencies) ||
      !(await nativeArtifactDependenciesStillMatch(record.dependencies))
    ) {
      return null;
    }
    return record.digest;
  } catch {
    return null;
  }
}

/** Records the digest of the installed helper beside its package files, so the
 * next build can validate it with a stat proof instead of reading and hashing
 * the binary. Publication is atomic and private; the caller ignores failures,
 * since an installation that cannot hold the record still builds. */
export async function writeHelperIdentity(
  packageJsonPath: string,
  binaryPath: string,
  digest: string,
  dependencies: readonly NativeArtifactDependency[],
): Promise<void> {
  const packageRoot = dirname(packageJsonPath);
  const destination = identityRecordPath(packageRoot);
  const record: HelperIdentityRecord = {
    version: RECORD_VERSION,
    binary: recordBinaryName(packageRoot, binaryPath),
    digest,
    dependencies: [...dependencies],
  };
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
