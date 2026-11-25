import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { buildLoadPlan } from "./load-plan.js";

/** The hooks file runs in the island bootstrap's scope: load it here as a
 * module of its own so `scriptcLoadPlan` can be called directly. */
function hooksModule(): { scriptcLoadPlan: (root: string, given: string) => void } {
  const source = readFileSync(
    fileURLToPath(new URL("../../../runtime/src/scr_node_island_hooks.cjs", import.meta.url)),
    "utf8",
  );
  const root = mkdtempSync(join(tmpdir(), "scriptc-plan-hooks-"));
  const file = join(root, "hooks.cjs");
  writeFileSync(file, `${source}\nmodule.exports = { scriptcLoadPlan };\n`);
  return createRequire(import.meta.url)(file);
}

describe("the load plan against a package's own loader", () => {
  test("a registered asynchronous loader still answers the imports it names", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-plan-async-")));
    const files: Record<string, string> = {
      "node_modules/asyncpkg/package.json": JSON.stringify({
        name: "asyncpkg",
        version: "1.0.0",
        type: "module",
        main: "index.js",
      }),
      "node_modules/asyncpkg/index.js": `import { register } from "node:module";
register(new URL("./loader.mjs", import.meta.url));
export async function report() {
  const { tag } = await import("./aliased.js");
  return \`tag \${tag}\`;
}
`,
      "node_modules/asyncpkg/loader.mjs": `export async function resolve(specifier, context, next) {
  if (specifier === "./aliased.js")
    return { url: new URL("./tag.js", context.parentURL).href, format: "module", shortCircuit: true };
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.endsWith("/tag.js"))
    return { format: "module", source: 'export const tag = "from the loader";', shortCircuit: true };
  return next(url, context);
}
`,
      "node_modules/asyncpkg/aliased.js": `export const tag = "from the tree";\n`,
      "node_modules/asyncpkg/tag.js": `export const tag = "from the tree";\n`,
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const plan = buildLoadPlan(
      {
        files: Object.keys(files)
          .sort()
          .map((path) => ({ path, size: files[path]!.length, sha256: "" })),
        links: [],
      },
      (path) => files[path] ?? null,
    );
    expect(plan).not.toBeNull();
    mkdirSync(join(root, ".scriptc"), { recursive: true });
    writeFileSync(join(root, ".scriptc", "load-plan"), plan!.bytes);

    hooksModule().scriptcLoadPlan(root, root);

    const loaded = (await import(
      pathToFileURL(join(root, "node_modules/asyncpkg/index.js")).href
    )) as {
      report?: () => Promise<string>;
      default?: { report: () => Promise<string> };
    };
    const report = loaded.report ?? loaded.default!.report;
    expect(await report()).toBe("tag from the loader");
  });
});
