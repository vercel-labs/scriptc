/* A class whose constructor answers a foreign object (xdg-app-paths's shape:
 * `module.exports = new C()`, the constructor returns a function with
 * members). The export is that object, so its value is checked-dynamic:
 * callable, with its members, as Node's. A class without such a constructor
 * keeps its instance representation. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../index.js";

const execFileAsync = promisify(execFile);

function project(pkg: { types?: string; js: string }, main: string): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-foreign-ctor-"));
  const module = join(dir, "node_modules", "pkg");
  mkdirSync(module, { recursive: true });
  writeFileSync(
    join(module, "package.json"),
    JSON.stringify({ name: "pkg", version: "1.0.0", main: "index.js", types: "index.d.ts" }),
  );
  writeFileSync(join(module, "index.js"), pkg.js);
  if (pkg.types !== undefined) writeFileSync(join(module, "index.d.ts"), pkg.types);
  writeFileSync(join(dir, "main.ts"), main);
  return dir;
}

async function run(entry: string, outDir: string, npmStatic: string[]): Promise<string> {
  const result = await compile(entry, { outPath: join(outDir, "main"), outDir, npmStatic });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  const { stdout } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
  return stdout;
}

const XDG_JS = `class _XDGAppPaths {
  constructor(name) {
    this._fn = (options) => \`\${name}:\${options}\`;
    this._fn.$name = () => name;
    return this._fn;
  }
}
module.exports = new _XDGAppPaths("sandbox");
`;

const XDG_TYPES = `declare namespace XDGAppPaths {
  function $name(): string;
}
declare function XDGAppPaths(options?: string): typeof XDGAppPaths;
export = XDGAppPaths;
`;

test(
  "a class whose constructor answers a function exports that function",
  { timeout: 600_000 },
  async () => {
    const dir = project(
      { types: XDG_TYPES, js: XDG_JS },
      'import xdg from "pkg";\nconsole.log(typeof xdg, xdg.$name(), xdg("cache"));\n',
    );
    expect(await run(join(dir, "main.ts"), dir, ["pkg"])).toBe("function sandbox sandbox:cache\n");
  },
);

test(
  "a class without a foreign return keeps its instance representation",
  { timeout: 600_000 },
  async () => {
    const dir = project(
      {
        types:
          "export declare class Counter { count: number; constructor(n: number); inc(): number; }\n",
        js: "class Counter {\n  constructor(n) { this.count = n; }\n  inc() { return ++this.count; }\n}\nmodule.exports = { Counter };\n",
      },
      'import { Counter } from "pkg";\nconst c = new Counter(1);\nconsole.log(c.inc(), c instanceof Counter, typeof Counter);\n',
    );
    expect(await run(join(dir, "main.ts"), dir, ["pkg"])).toBe("2 true function\n");
  },
);
