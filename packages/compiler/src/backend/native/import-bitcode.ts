/* Runtime import bitcode, verified and staged before the helper reads it.
 *
 * The pack manifest names each variant's bitcode with its size and sha256,
 * like every other artifact. The helper imports the bodies it can take from
 * those files, so a bitcode file swapped after selection would change the
 * generated code while the manifest and the verified runtime objects still
 * look untouched. Both program-build paths therefore stage a private copy of
 * each selected artifact from bytes that matched the manifest, and pass only
 * those copies to the helper; a mismatch fails the build.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { RuntimePackError, type RuntimePackArtifact } from "../runtime-pack-core.js";

function mismatch(artifact: RuntimePackArtifact, reason: string): RuntimePackError {
  return new RuntimePackError(
    `runtime pack bitcode artifact ${reason}: ${artifact.path}`,
    "invalid",
    "the runtime pack on disk does not match its manifest; reinstall the matching runtime package",
  );
}

function check(artifact: RuntimePackArtifact, bytes: Buffer): Buffer {
  if (bytes.length !== artifact.size) throw mismatch(artifact, "has the wrong size");
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)
    throw mismatch(artifact, "hash mismatch");
  return bytes;
}

function publish(dir: string, index: number, artifact: RuntimePackArtifact, bytes: Buffer): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The index keeps two units' same-named files apart; the name keeps a
  // diagnostic readable.
  const path = join(dir, `${index}-${basename(artifact.path)}`);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o400 });
  return path;
}

/** Stages a private copy of each artifact for a synchronous build, after
 * checking its bytes against the manifest. Returns the staged paths in the
 * selection's order. */
export function stageImportBitcodeSync(
  root: string,
  artifacts: readonly RuntimePackArtifact[],
  dir: string,
): string[] {
  if (artifacts.length === 0) return [];
  return artifacts.map((artifact, index) => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(root, artifact.path));
    } catch {
      throw mismatch(artifact, "is missing");
    }
    return publish(dir, index, artifact, check(artifact, bytes));
  });
}

/** The plain-Node build's form of stageImportBitcodeSync. */
export async function stageImportBitcode(
  root: string,
  artifacts: readonly RuntimePackArtifact[],
  dir: string,
): Promise<string[]> {
  if (artifacts.length === 0) return [];
  const paths: string[] = [];
  for (const [index, artifact] of artifacts.entries()) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(root, artifact.path));
    } catch {
      throw mismatch(artifact, "is missing");
    }
    paths.push(publish(dir, index, artifact, check(artifact, bytes)));
  }
  return paths;
}
