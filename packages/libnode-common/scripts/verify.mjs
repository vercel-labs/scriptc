#!/usr/bin/env node
// Verifies a built libnode pack before it is packed or published: the
// manifest matches the package, the pin and the bridge ABI; every library
// it lists exists with the recorded size and SHA-256; the license files are
// present.
//
//   node packages/libnode-common/scripts/verify.mjs <package directory>
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LIBNODE_PACK_SCHEMA, bridgeAbi, packFileNames, platformInfo, readPin } from "./pin.mjs";

/** The problems with the pack in `root`; empty when it is complete. */
export function verifyPack(root) {
  const problems = [];
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) return [`${manifestPath} is missing; run build:native first`];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const pin = readPin();
  const platform = String(packageJson.name).replace(/^@scriptc\/libnode-/, "");
  const expect = (field, actual, expected) => {
    if (actual !== expected) problems.push(`manifest ${field} is ${actual}, expected ${expected}`);
  };
  expect("schema", manifest.schema, LIBNODE_PACK_SCHEMA);
  expect("package", manifest.package, packageJson.name);
  expect("version", manifest.version, packageJson.version);
  expect("target", manifest.target, platform);
  expect("platform", manifest.platform, platformInfo(platform).os);
  expect("arch", manifest.arch, platformInfo(platform).arch);
  expect("nodeVersion", manifest.nodeVersion, pin.nodeVersion);
  expect("moduleVersion", manifest.moduleVersion, pin.moduleVersion);
  expect("bridgeAbi", manifest.bridgeAbi, bridgeAbi());
  const names = packFileNames(platform, pin.moduleVersion);
  expect("libnode", manifest.libnode, names.libnode);
  expect("bridge", manifest.bridge, names.bridge);
  for (const name of [names.libnode, names.bridge]) {
    const entry = manifest.files?.[name];
    const path = join(root, name);
    if (entry === undefined) problems.push(`manifest lists no ${name}`);
    else if (!existsSync(path)) problems.push(`${name} is missing`);
    else if (statSync(path).size !== entry.size) problems.push(`${name} has the wrong size`);
    else if (createHash("sha256").update(readFileSync(path)).digest("hex") !== entry.sha256) {
      problems.push(`${name} has the wrong SHA-256`);
    }
    if (!packageJson.files.includes(name)) problems.push(`package.json files omits ${name}`);
  }
  for (const name of ["LICENSE", "SCRIPTC_LICENSE", "THIRD_PARTY_NOTICES"]) {
    if (!existsSync(join(root, name))) problems.push(`${name} is missing`);
  }
  if (existsSync(join(root, "LICENSE"))) {
    const license = readFileSync(join(root, "LICENSE"), "utf8");
    if (!license.startsWith("Node.js is licensed for use as follows:")) {
      problems.push("LICENSE is not the Node.js LICENSE file");
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? ".");
  const problems = verifyPack(root);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`libnode pack ${root}: ${problem}`);
    process.exit(1);
  }
  console.log(`libnode pack ${root} verified`);
}
