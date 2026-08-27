#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "runtime-pack.json"), "utf8"));
const packageManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (
  manifest.schema !== "scriptc.runtime-pack.v1" || manifest.format !== 1 ||
  manifest.package !== packageManifest.name || manifest.version !== packageManifest.version
) throw new Error("runtime pack identity does not match package.json");
const artifacts = [
  ...Object.values(manifest.flavors).flatMap((flavor) =>
    flavor.runtime_units.flatMap((unit) => unit.variants)),
  ...manifest.archives,
];

function printableStrings(bytes) {
  const strings = [];
  let start = -1;
  for (let i = 0; i <= bytes.length; i++) {
    const byte = bytes[i];
    if (byte !== undefined && byte >= 0x20 && byte <= 0x7e) {
      if (start === -1) start = i;
      continue;
    }
    if (start !== -1 && i - start >= 4) strings.push(bytes.subarray(start, i).toString("ascii"));
    start = -1;
  }
  return strings;
}

for (const artifact of artifacts) {
  const path = join(root, artifact.path);
  const bytes = await readFile(path);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== artifact.size || digest !== artifact.sha256) {
    throw new Error(`runtime pack hash mismatch: ${artifact.path}`);
  }
  const checkoutPath = printableStrings(bytes).find((value) =>
    value.startsWith("/") && value.includes("/packages/runtime/")
  );
  if (checkoutPath !== undefined) {
    throw new Error(`runtime pack contains an absolute source path in ${artifact.path}: ${checkoutPath}`);
  }
}
for (const license of manifest.licenses) await access(join(root, license.path));
process.stdout.write(`verified ${manifest.package}@${manifest.version}: ${artifacts.length} artifacts\n`);
