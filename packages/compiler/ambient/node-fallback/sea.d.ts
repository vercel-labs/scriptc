/* node:sea — single-executable applications (prefix-only in Node too:
 * require("sea") is MODULE_NOT_FOUND). A compiled program is not a Node
 * single-executable application and holds no injected assets, so the
 * module answers what Node answers outside one: isSea() is false, and the
 * asset readers validate their arguments and then throw
 * ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION. */
declare module "node:sea" {
  type AssetKey = string;
  export function isSea(): boolean;
  export function getAsset(key: AssetKey): ArrayBuffer;
  export function getAsset(key: AssetKey, encoding: string): string;
  export function getAssetAsBlob(key: AssetKey, options?: { type: string }): Blob;
  export function getRawAsset(key: AssetKey): ArrayBuffer;
  export function getAssetKeys(): string[];
}
