import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import ts5 from "typescript";

/** `// @tsc-jsx` in a directory program's main.ts head: Node cannot run
 * .tsx or .jsx modules, so the oracle runs TypeScript's own emit of the
 * program. Every .ts, .tsx, .js and .jsx file of the directory is transpiled
 * (target ES2022, ES modules) with the jsx options of the directory's
 * tsconfig.json, .ts, .tsx and .jsx files becoming .js, and package.json import
 * and export targets renamed alike; other files are copied.
 * The result lives in a directory under the test cache keyed by the program
 * bytes and the typescript version. */
export function wantsTscJsx(head: readonly string[]): boolean {
  return head.some((line) => /^\/\/ @tsc-jsx\s*$/.test(line));
}

/** The oracle entry (`main.js` of the transpiled program) for `file`. */
export function tscJsxOracleEntry(file: string, cacheDir: string): string {
  const root = dirname(file);
  const files = listFiles(root);
  const hash = createHash("sha256").update(ts5.version);
  for (const path of files)
    hash.update("\0").update(relative(root, path)).update("\0").update(readFileSync(path));
  const dir = join(cacheDir, `jsx-oracle-${hash.digest("hex").slice(0, 16)}`);
  const entry = join(dir, "main.js");
  if (existsSync(entry)) return entry;
  const configPath = join(root, "tsconfig.json");
  const config = existsSync(configPath)
    ? ts5.parseJsonConfigFileContent(
        ts5.readConfigFile(configPath, ts5.sys.readFile).config ?? {},
        ts5.sys,
        root,
      ).options
    : {};
  const compilerOptions: ts5.CompilerOptions = {
    target: ts5.ScriptTarget.ES2022,
    module: ts5.ModuleKind.ESNext,
    jsx: config.jsx,
    jsxFactory: config.jsxFactory,
    jsxFragmentFactory: config.jsxFragmentFactory,
    jsxImportSource: config.jsxImportSource,
    reactNamespace: config.reactNamespace,
  };
  // Atomic publish: build beside the final directory, then rename it into
  // place; a concurrent suite that wins the rename leaves the same content.
  const staging = `${dir}.${process.pid}.tmp`;
  rmSync(staging, { recursive: true, force: true });
  for (const path of files) {
    const target = join(staging, relative(root, path));
    mkdirSync(dirname(target), { recursive: true });
    if (/\.(?:[cm]?ts|tsx|jsx?|[cm]js)$/.test(path) && !/\.d\.[cm]?ts$/.test(path)) {
      const output = ts5.transpileModule(readFileSync(path, "utf8"), {
        compilerOptions,
        fileName: path,
      }).outputText;
      writeFileSync(
        target
          .replace(/\.(?:ts|tsx|jsx)$/, ".js")
          .replace(/\.mts$/, ".mjs")
          .replace(/\.cts$/, ".cjs"),
        output,
      );
    } else if (/(^|\/)package\.json$/.test(path)) {
      // Import and export targets follow their files: .ts, .tsx and .jsx
      // become .js.
      const renamed = (value: unknown): unknown =>
        typeof value === "string"
          ? /\.d\.[cm]?ts$/.test(value)
            ? value
            : value
                .replace(/\.(?:ts|tsx|jsx)$/, ".js")
                .replace(/\.mts$/, ".mjs")
                .replace(/\.cts$/, ".cjs")
          : Array.isArray(value)
            ? value.map(renamed)
            : value !== null && typeof value === "object"
              ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renamed(item)]))
              : value;
      writeFileSync(
        target,
        `${JSON.stringify(renamed(JSON.parse(readFileSync(path, "utf8"))), null, 2)}\n`,
      );
    } else {
      copyFileSync(path, target);
    }
  }
  if (!existsSync(join(staging, "package.json")))
    writeFileSync(join(staging, "package.json"), '{ "type": "module" }\n');
  try {
    renameSync(staging, dir);
  } catch {
    rmSync(staging, { recursive: true, force: true });
  }
  return entry;
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  visit(root);
  return out;
}
