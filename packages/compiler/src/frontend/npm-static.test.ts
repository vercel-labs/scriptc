import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { setFrontendIslands } from "../node-islands/boundary.js";
import {
  npmStaticFsShadow,
  npmStaticIneligibleReason,
  setNpmStaticPackages,
  npmStaticTransformPkgJson,
} from "./npm-static.js";
import type { FrontendServices } from "./services.js";

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

test("a typed island package's shipped JS never reaches the checker under --npm-static", async () => {
  // The flag's maxNodeModuleJsDepth admits node_modules JS the flagless build
  // never types, and a real file SHADOWS the ambient `declare module`
  // declarations that type an island (highlight.js: lib/core.js typed by
  // JSDoc instead of types/index.d.ts, which cascades into the importing
  // program). A TYPED island's declarations are its whole surface, so its
  // runtime files stay out; declarations stay in. An UNTYPED island has no
  // declaration to shadow and keeps the any-surface stub.
  const dir = await mkdtemp("/tmp/scriptc-npm-static-island-");
  try {
    const typed = join(dir, "node_modules", "islanded");
    const untyped = join(dir, "node_modules", "plainisl");
    await mkdir(join(typed, "lib"), { recursive: true });
    await mkdir(join(typed, "types"), { recursive: true });
    await mkdir(join(untyped, "lib"), { recursive: true });
    await writeFile(
      join(typed, "package.json"),
      JSON.stringify({ name: "islanded", types: "./types/index.d.ts" }),
    );
    await writeFile(join(typed, "lib", "core.js"), "module.exports = {};\n");
    await writeFile(join(typed, "types", "index.d.ts"), "declare const x: {}; export = x;\n");
    await writeFile(join(untyped, "package.json"), JSON.stringify({ name: "plainisl" }));
    await writeFile(join(untyped, "lib", "core.js"), "module.exports = {};\n");
    // The load keeps islands OUT of the flag's name list; the shadow's island
    // rule is what keeps their JS out of the checker.
    setNpmStaticPackages(["opted"]);
    setFrontendIslands(new Set(["islanded", "plainisl"]));
    const shadow = npmStaticFsShadow({} as FrontendServices);
    expect(shadow).not.toBeNull();
    const hide = shadow === null ? null : shadow.hideFile;
    expect(hide?.(`${typed}/lib/core.js`)).toBe(true);
    expect(hide?.(`${dir.replaceAll("/", "\\")}\\node_modules\\islanded\\index.cjs`)).toBe(true);
    // The declarations are what types the island: they stay.
    expect(hide?.(`${typed}/types/index.d.ts`)).toBe(false);
    // An untyped island keeps the shadow's existing any-surface stub.
    expect(hide?.(`${untyped}/lib/core.js`)).toBe(false);
    // A package that is not an island keeps the ordinary shadow rules.
    expect(hide?.(join(dir, "node_modules", "opted", "lib", "core.js"))).toBe(false);
    // Files outside node_modules are untouched by the island rule.
    expect(hide?.(join(dir, "src", "islanded.js"))).toBe(false);
  } finally {
    setFrontendIslands(new Set());
    setNpmStaticPackages([]);
    await rm(dir, { recursive: true, force: true });
  }
});
