import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { npmStaticIneligibleReason, npmStaticTransformPkgJson } from "./npm-static.js";

test("an unreadable runtime entry is an eligibility refusal", async () => {
  const dir = await mkdtemp("/tmp/scriptc-npm-static-unreadable-");
  try {
    const root = join(dir, "node_modules", "example");
    expect(npmStaticIneligibleReason("example", `${root}/index.d.ts`, `${root}/index.js`)).toBe(
      `its runtime entry ${root}/index.js cannot be read`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hoisted node condition leaves no types claim behind", () => {
  // uuid 14: the node object carries its own "types" key. Left in place,
  // tsgo maps the hidden declaration to its same-stem browser build.
  const pkg: Record<string, unknown> = {
    types: "./dist/index.d.ts",
    exports: {
      ".": {
        node: { types: "./dist/index.d.ts", default: "./dist-node/index.js" },
        default: "./dist/index.js",
      },
      "./package.json": "./package.json",
    },
  };
  npmStaticTransformPkgJson(pkg);
  expect(pkg).toEqual({
    exports: {
      ".": { default: "./dist-node/index.js" },
      "./package.json": "./package.json",
    },
  });
});
