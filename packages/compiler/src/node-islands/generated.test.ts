import { describe, expect, test } from "vitest";
import {
  generatedModuleName,
  generatedModuleText,
  generatedTreeFile,
  generatedTreePath,
  probeCopy,
  type GeneratedModule,
} from "./generated.js";

const module: GeneratedModule = {
  source: "/work/app/src/tools/read.ts",
  index: 1,
  imports: [
    { clause: "{ Kit }", target: "/work/app/node_modules/shape-kit/index.js" },
    { clause: "{ item as row }", target: "/work/app/src/shapes.ts.closed.0.mjs" },
  ],
  body: 'export const list = Kit.list(row);\nexport const note = "import x from \\"y\\";";\n',
};

describe("generated island modules", () => {
  test("are named after their source module's path in the tree, never the build machine's", () => {
    const name = generatedModuleName("src/tools/read.ts", 1);
    expect(name).toMatch(/^read\.[0-9a-f]{10}\.1\.mjs$/);
    expect(generatedModuleName("src/tools/read.ts", 1)).toBe(name);
    expect(generatedModuleName("src/other/read.ts", 1)).not.toBe(name);
    expect(generatedModuleName("src/tools/read.ts", 0)).not.toBe(name);
    expect(generatedModuleName("src/we ird$.mts", 0)).toMatch(/^we_ird_\.[0-9a-f]{10}\.0\.mjs$/);
    expect(generatedTreePath(name)).toBe(`.scriptc/closed/${name}`);
  });

  test("import by the specifiers they are given, then export their constants", () => {
    const text = generatedModuleText(module, [
      "../../node_modules/shape-kit/index.js",
      "./shapes.0123456789.0.mjs",
    ]);
    expect(text).toBe(
      'import { Kit } from "../../node_modules/shape-kit/index.js";\n' +
        'import { item as row } from "./shapes.0123456789.0.mjs";\n' +
        module.body,
    );
  });

  test("the probe's copy names the build machine's files and the other copies", () => {
    const text = generatedModuleText(module, [
      "../../node_modules/shape-kit/index.js",
      "./shapes.0123456789.0.mjs",
    ]);
    const place = generatedTreeFile("/work/app", "read.aaaaaaaaaa.1.mjs");
    const other = generatedTreeFile("/work/app", "shapes.0123456789.0.mjs");
    const copy = probeCopy(text, place, (file) =>
      file === other ? "/tmp/probe/shapes.0123456789.0.mjs" : undefined,
    );
    expect(copy).toBe(
      'import { Kit } from "/work/app/node_modules/shape-kit/index.js";\n' +
        'import { item as row } from "/tmp/probe/shapes.0123456789.0.mjs";\n' +
        module.body,
    );
  });
});
