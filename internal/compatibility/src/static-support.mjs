/* Load the static-support overlay from its per-module parts.
 *
 * `static-support.json` is the index: it names the chapter-policy file and
 * the directories whose `*.json` files hold the evidence map, the feature
 * rows and the dedicated lowering rows. Each directory is read in filename
 * order, so the merged table does not depend on directory enumeration order.
 * Add a module by adding its file; only a new directory needs an index edit.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

/** Parse one index entry: a single file, or a `dir/*.json` directory. */
function readParts(spec) {
  if (!spec.endsWith("/*.json")) return [JSON.parse(readFileSync(packageRoot + spec, "utf8"))];
  const dir = packageRoot + spec.slice(0, -"*.json".length);
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  return files.map((file) => JSON.parse(readFileSync(dir + file, "utf8")));
}

/** The overlay the compatibility generator classifies with. */
export function loadStaticSupport(indexPath = `${packageRoot}static-support.json`) {
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  return {
    schemaVersion: index.schemaVersion,
    chapterPolicies: readParts(index.chapterPolicies)[0],
    evidenceByManifestPrefix: Object.assign({}, ...readParts(index.evidence)),
    features: readParts(index.features).flat(),
    dedicated: readParts(index.dedicated).flat(),
  };
}
