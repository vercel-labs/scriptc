#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.SCRIPTC_RUNTIME_PACK_ROOT;
if (!root) throw new Error("runtime-pack verification requires package wrapper configuration");
const manifest = JSON.parse(await readFile(join(root, "runtime-pack.json"), "utf8"));
const packageManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (manifest.schema !== "scriptc.runtime-pack.v1" || manifest.format !== 1 || manifest.package !== packageManifest.name || manifest.version !== packageManifest.version) throw new Error("runtime pack identity does not match package.json");
const artifacts = [...Object.values(manifest.flavors).flatMap((flavor) => flavor.runtime_units.flatMap((unit) => unit.variants)), ...manifest.archives];
for (const artifact of artifacts) {
  const bytes = await readFile(join(root, artifact.path));
  if (bytes.length !== artifact.size || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error(`runtime pack hash mismatch: ${artifact.path}`);
}
for (const license of manifest.licenses) await access(join(root, license.path));
process.stdout.write(`verified ${manifest.package}@${manifest.version}: ${artifacts.length} artifacts\n`);
