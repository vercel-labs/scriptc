// node:sea in a program that is not a Node single-executable application:
// isSea() is false, the asset readers throw Node's coded error, and
// process.getBuiltinModule answers the module for the prefixed id only.
import * as sea from "node:sea";
import { getAsset, getAssetKeys, getRawAsset, isSea } from "node:sea";

// A module-level probe through an optional call (the loader idiom).
const isSeaBinary =
  ("sea" in process.features && process.features.sea === true) ||
  process.getBuiltinModule("node:sea")?.isSea() === true;
console.log("sea binary:", isSeaBinary);

console.log(isSea(), sea.isSea(), isSea() === false);
console.log(typeof sea.getAsset, typeof sea.getRawAsset, typeof sea.getAssetAsBlob, typeof sea.getAssetKeys);

const loaded = process.getBuiltinModule("node:sea");
console.log(loaded.isSea(), typeof loaded.getAssetKeys);

function report(label: string, read: () => unknown): void {
  try {
    console.log(label, "returned", typeof read());
  } catch (error) {
    const e = error as Error & { code?: string };
    console.log(label, e.name, e.code, e.message, e instanceof Error, e instanceof TypeError);
  }
}
report("getAsset", () => getAsset("a.txt"));
report("getAsset utf8", () => sea.getAsset("a.txt", "utf8"));
report("getRawAsset", () => getRawAsset("a.txt"));
report("getAssetAsBlob", () => sea.getAssetAsBlob("a.txt", { type: "text/plain" }));
report("getAssetKeys", () => getAssetKeys());

// A branch on the answer takes the path Node takes.
function assetOrFile(name: string): string {
  return isSea() ? String(getAsset(name, "utf8")) : `file:${name}`;
}
console.log(assetOrFile("config.json"));
