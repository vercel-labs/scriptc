/** Synchronous runtime-pack host for the statically compiled driver. Each
 * selected artifact is verified and copied from the same read into private
 * storage. With a store, a pack's selections and the identities of the
 * artifacts it verified are kept between builds: an artifact whose file
 * identity is unchanged since it was hashed is not hashed again. */
import type { NativeOptimization } from "./optimization.js";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { NativeLinkFeatures } from "./native-link-info.js";
import type { NativeTargetSpec } from "./targets.js";
import {
  RuntimePackError,
  parseRuntimePackManifest,
  selectRuntimePackArtifacts,
  validateRuntimePackIdentity,
  type RuntimePackArtifact,
  type RuntimePackArtifacts,
  type RuntimePackManifest,
  type RuntimePackMode,
} from "./runtime-pack-core.js";

export interface NativeRuntimePack {
  runtimeObjects: string[];
  archives: string[];
  systemLibraries: string[];
}

export interface NativeRuntimeSelection {
  root: string;
  /** The parsed manifest; a selection read from a store has none until
   * runtimePackManifest parses it. */
  manifest?: RuntimePackManifest;
  licenses: RuntimePackManifest["licenses"];
  packageText: string;
  manifestText: string;
  selected: RuntimePackArtifacts;
  flavor: NativeOptimization;
}

/** Text entries kept between builds (the native compiler's cache). */
export interface RuntimePackStore {
  read(key: string): string | null;
  write(key: string, text: string): void;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtime: number;
  ctime: number;
}

function fileIdentity(path: string): FileIdentity {
  const info = statSync(path);
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtime: info.mtimeMs,
    ctime: info.ctimeMs,
  };
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtime === b.mtime &&
    a.ctime === b.ctime
  );
}

function storeKey(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A stored selection: what selecting from the pack's files, with these
 * identities, returned. */
interface StoredSelection {
  schema: 1;
  licenses: RuntimePackManifest["licenses"];
  selected: RuntimePackArtifacts;
}

export function selectNativeRuntimePack(
  root: string,
  target: NativeTargetSpec,
  compilerVersion: string,
  features: NativeLinkFeatures,
  flavor: NativeOptimization,
  mode: RuntimePackMode = "executable",
  store?: RuntimePackStore,
): NativeRuntimeSelection {
  const packagePath = join(root, "package.json");
  const manifestPath = join(root, "runtime-pack.json");
  if (!existsSync(packagePath)) {
    throw new RuntimePackError(
      `runtime pack for ${target.name} is not installed; install ${target.runtimePackPackage}@${compilerVersion} in your project or set SCRIPTC_RUNTIME_PACK to its directory`,
      "missing",
      "scriptc includes the runtime pack for its own platform only; other targets need their runtime pack package in the project",
    );
  }
  // The pack's files by identity, with everything else selection reads.
  let key: string | null = null;
  let identities: FileIdentity[] = [];
  if (store !== undefined) {
    try {
      identities = [fileIdentity(packagePath), fileIdentity(manifestPath)];
      key = storeKey(
        JSON.stringify({
          schema: 1,
          root,
          identities,
          target: target.name,
          compilerVersion,
          features,
          flavor,
          mode,
        }),
      );
      const stored = readStoredSelection(store.read(key));
      if (stored !== null) {
        const packageText = readFileSync(packagePath, "utf8");
        const manifestText = readFileSync(manifestPath, "utf8");
        // The texts read are the ones with the stored identities.
        if (
          sameIdentity(fileIdentity(packagePath), identities[0]!) &&
          sameIdentity(fileIdentity(manifestPath), identities[1]!)
        ) {
          return {
            root,
            licenses: stored.licenses,
            packageText,
            manifestText,
            selected: stored.selected,
            flavor,
          };
        }
      }
    } catch {
      key = null;
    }
  }
  const packageText = readFileSync(packagePath, "utf8");
  const manifestText = readFileSync(manifestPath, "utf8");
  const identity = JSON.parse(packageText) as { name?: string; version?: string };
  const manifest = parseRuntimePackManifest(JSON.parse(manifestText));
  validateRuntimePackIdentity(manifest, identity.name, identity.version, target, compilerVersion);
  const selected = selectRuntimePackArtifacts(manifest, features, flavor, process.env, mode);
  if (store !== undefined && key !== null) {
    try {
      // Stored only when the files selected from still have the identities
      // in the key.
      if (
        sameIdentity(fileIdentity(packagePath), identities[0]!) &&
        sameIdentity(fileIdentity(manifestPath), identities[1]!)
      ) {
        const entry: StoredSelection = { schema: 1, licenses: manifest.licenses, selected };
        store.write(key, JSON.stringify(entry));
      }
    } catch {
      /* A failed write is a later miss. */
    }
  }
  return {
    root,
    manifest,
    licenses: manifest.licenses,
    packageText,
    manifestText,
    selected,
    flavor,
  };
}

/** The selection's parsed manifest. */
export function runtimePackManifest(selection: NativeRuntimeSelection): RuntimePackManifest {
  return (selection.manifest ??= parseRuntimePackManifest(JSON.parse(selection.manifestText)));
}

function readStoredSelection(text: string | null): StoredSelection | null {
  if (text === null) return null;
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object") return null;
  const entry = value as Partial<StoredSelection>;
  if (
    entry.schema !== 1 ||
    !Array.isArray(entry.licenses) ||
    entry.selected === undefined ||
    entry.selected === null ||
    typeof entry.selected !== "object" ||
    !Array.isArray(entry.selected.runtime) ||
    !Array.isArray(entry.selected.archives) ||
    !Array.isArray(entry.selected.systemLibraries)
  )
    return null;
  return entry as StoredSelection;
}

/** An artifact path's identity when its bytes last matched the manifest's
 * size and digest. */
interface VerifiedArtifact {
  path: string;
  sha256: string;
  dev: number;
  ino: number;
  size: number;
  mtime: number;
  ctime: number;
}

interface StoredVerification {
  schema: number;
  artifacts: VerifiedArtifact[];
}

function readVerified(
  store: RuntimePackStore | undefined,
  key: string,
): Map<string, VerifiedArtifact> {
  const verified = new Map<string, VerifiedArtifact>();
  try {
    const text = store?.read(key) ?? null;
    if (text === null) return verified;
    const stored = JSON.parse(text) as StoredVerification;
    if (stored.schema === 1)
      for (const artifact of stored.artifacts) verified.set(artifact.path, artifact);
  } catch {
    /* A malformed entry verifies everything again. */
  }
  return verified;
}

function stageArtifact(
  root: string,
  stage: string,
  artifact: RuntimePackArtifact,
  verified: Map<string, VerifiedArtifact>,
  newlyVerified: VerifiedArtifact[],
): string {
  const source = join(root, artifact.path);
  const destination = join(stage, artifact.path);
  let bytes: Buffer;
  let before: FileIdentity;
  let after: FileIdentity;
  try {
    before = fileIdentity(source);
    bytes = readFileSync(source);
    after = fileIdentity(source);
  } catch {
    throw new RuntimePackError(`runtime pack artifact is missing: ${artifact.path}`, "invalid");
  }
  // The bytes are those last hashed when the file kept the identity it had
  // then for the whole read.
  const known = verified.get(artifact.path);
  const unchanged = sameIdentity(before, after);
  const trusted =
    known !== undefined &&
    known.sha256 === artifact.sha256 &&
    known.size === artifact.size &&
    unchanged &&
    known.dev === before.dev &&
    known.ino === before.ino &&
    known.size === before.size &&
    known.mtime === before.mtime &&
    known.ctime === before.ctime;
  if (
    bytes.length !== artifact.size ||
    (!trusted && createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)
  ) {
    throw new RuntimePackError(`runtime pack artifact hash mismatch: ${artifact.path}`, "invalid");
  }
  if (!trusted && unchanged)
    newlyVerified.push({
      path: artifact.path,
      sha256: artifact.sha256,
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtime: before.mtime,
      ctime: before.ctime,
    });
  mkdirSync(dirname(destination), { recursive: true });
  const fd = openSync(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o400,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written === 0)
        throw new RuntimePackError(
          `could not stage runtime pack artifact: ${artifact.path}`,
          "invalid",
        );
      offset += written;
    }
  } finally {
    closeSync(fd);
  }
  return destination;
}

/** stageRoot must be a new private directory owned by the caller. The caller
 * removes it on success or failure, after all native tools have finished. */
export function stageNativeRuntimePack(
  root: string,
  stageRoot: string,
  target: NativeTargetSpec,
  compilerVersion: string,
  features: NativeLinkFeatures,
  flavor: NativeOptimization,
  mode: RuntimePackMode = "executable",
): NativeRuntimePack {
  return stageNativeRuntimeSelection(
    selectNativeRuntimePack(root, target, compilerVersion, features, flavor, mode),
    stageRoot,
  );
}

export function stageNativeRuntimeSelection(
  selection: NativeRuntimeSelection,
  stageRoot: string,
  store?: RuntimePackStore,
): NativeRuntimePack {
  const { root, licenses, selected, packageText, manifestText } = selection;
  const packagePath = join(root, "package.json");
  const manifestPath = join(root, "runtime-pack.json");
  const key = storeKey(JSON.stringify({ schema: 1, verified: root }));
  const verified = readVerified(store, key);
  const newlyVerified: VerifiedArtifact[] = [];
  const stage = (artifact: RuntimePackArtifact): string =>
    stageArtifact(root, stageRoot, artifact, verified, newlyVerified);
  const runtimeObjects = selected.runtime.map(stage);
  const archives = selected.archives.map(stage);
  for (const license of licenses) {
    try {
      readFileSync(join(root, license.path));
    } catch {
      throw new RuntimePackError("runtime pack license payload is incomplete", "invalid");
    }
  }
  if (
    readFileSync(packagePath, "utf8") !== packageText ||
    readFileSync(manifestPath, "utf8") !== manifestText
  ) {
    throw new RuntimePackError("runtime pack changed while staging verified artifacts", "invalid");
  }
  if (store !== undefined && newlyVerified.length > 0) {
    for (const artifact of newlyVerified) verified.set(artifact.path, artifact);
    const entry: StoredVerification = { schema: 1, artifacts: [...verified.values()] };
    try {
      store.write(key, JSON.stringify(entry));
    } catch {
      /* A failed write only means hashing again next time. */
    }
  }
  return { runtimeObjects, archives, systemLibraries: selected.systemLibraries };
}
