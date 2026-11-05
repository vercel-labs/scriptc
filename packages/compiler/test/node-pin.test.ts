/* Every Node pin names the same release: .node-version (the
 * differential oracle), Dockerfile.sandbox, the compatibility pin, the fetch
 * profile, the docs matrix fallback, and the version the compiled binary
 * reports. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { node24FetchCompatProfile } from "../src/compat/fetch-profile.js";
import { NODE_COMPAT_VERSION } from "../src/frontend/lowering/builtins/process.js";
import { CRYPTO_CONSTANTS } from "../src/frontend/lowering/crypto-tables.js";
import { ZLIB_CONSTANTS } from "../src/frontend/lowering/zlib-constants.js";

const repoRoot = join(import.meta.dirname, "../../..");
const read = (path: string): string => readFileSync(join(repoRoot, path), "utf8");

test("the Node pins agree", () => {
  const pinned = read(".node-version").trim();
  const compat = JSON.parse(read("internal/compatibility/node-v24.json")) as {
    version: string;
    tag: string;
  };
  expect(compat.version).toBe(pinned);
  expect(compat.tag).toBe(`v${pinned}`);
  expect(read("Dockerfile.sandbox")).toMatch(new RegExp(`^ARG NODE_VERSION=${pinned}$`, "m"));
  expect(NODE_COMPAT_VERSION).toBe(pinned);
  expect(node24FetchCompatProfile().target.node).toBe(pinned);
  expect(read("packages/runtime/src/scr_lib.c")).toContain(
    `#define SCR_NODE_COMPAT_VERSION "${pinned}"`,
  );
  expect(read("docs/src/components/node-compatibility-matrix.tsx")).toContain(
    `snapshot?.nodeVersion ?? "${pinned}"`,
  );
});

test("the crypto.constants declaration matches the baked table", () => {
  const dts = read("packages/compiler/ambient/node-fallback/crypto.d.ts");
  const start = dts.indexOf("export interface CryptoConstants {");
  const body = dts.slice(start, dts.indexOf("\n  }\n", start));
  const declared = Object.fromEntries(
    [...body.matchAll(/readonly (\w+): (-?\d+|"[^"]*");/g)].map(([, name, value]) => [
      name!,
      JSON.parse(value!) as number | string,
    ]),
  );
  expect(declared).toEqual(CRYPTO_CONSTANTS);
});

test("the zlib.constants declaration matches the baked table", () => {
  const dts = read("packages/compiler/ambient/node-fallback/zlib.d.ts");
  const start = dts.indexOf("export interface ZlibConstants {");
  const body = dts.slice(start, dts.indexOf("\n  }\n", start));
  const declared = Object.fromEntries(
    [...body.matchAll(/readonly (\w+): (-?\d+|number);/g)].map(([, name, value]) => [
      name!,
      value === "number" ? Infinity : Number(value),
    ]),
  );
  expect(declared).toEqual(ZLIB_CONSTANTS);
});
