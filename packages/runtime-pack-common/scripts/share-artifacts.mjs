import { readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";

/** Points the artifacts of one runtime unit that hold the same bytes at one
 * file and deletes the copies. Variants whose defines a unit does not read,
 * and flavors that compile a unit the same way, produce identical objects
 * and bitcode. Each link selects one flavor and one variant of each unit, so
 * no link names a shared file twice. `root` is the directory artifact paths
 * are relative to; flavors keep the order they were built in, so the first
 * flavor's path holds the shared file. */
export async function shareIdenticalArtifacts(flavors, root) {
  const firstPaths = new Map();
  for (const flavor of Object.values(flavors)) {
    for (const unit of flavor.runtime_units) {
      let paths = firstPaths.get(unit.source);
      if (paths === undefined) {
        paths = new Map();
        firstPaths.set(unit.source, paths);
      }
      for (const variant of unit.variants) {
        for (const artifact of variant.bitcode === undefined
          ? [variant]
          : [variant, variant.bitcode]) {
          const first = paths.get(artifact.sha256);
          if (first === undefined) {
            paths.set(artifact.sha256, artifact.path);
          } else if (first !== artifact.path) {
            await rm(join(root, artifact.path));
            artifact.path = first;
          }
        }
      }
    }
  }
  await removeEmptyDirectories(join(root, "artifacts"));
}

async function removeEmptyDirectories(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  let remaining = entries.length;
  for (const entry of entries) {
    if (entry.isDirectory() && (await removeEmptyDirectories(join(directory, entry.name))))
      remaining--;
  }
  if (remaining > 0) return false;
  await rmdir(directory);
  return true;
}
