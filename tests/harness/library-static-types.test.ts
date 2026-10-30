import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compileLibrary } from "@scriptc/compiler";

test.each(["sample", "@scope/sample"])(
  "explicit library attempts use %s runtime code with installed declaration twins",
  async (name) => {
    const dir = await mkdtemp("/tmp/scriptc-library-static-types-");
    try {
      const pkg = join(dir, "node_modules", name);
      const types = join(dir, "node_modules/@types", name.startsWith("@") ? "scope__sample" : name);
      await mkdir(pkg, { recursive: true });
      await mkdir(types, { recursive: true });
      await writeFile(join(dir, "package.json"), '{"type":"module"}');
      await writeFile(
        join(pkg, "package.json"),
        JSON.stringify({
          name,
          version: "1.0.0",
          type: "module",
          exports: { ".": "./index.js", "./value": "./index.js" },
        }),
      );
      await writeFile(
        join(pkg, "index.js"),
        "export function calculate(value) { return value * 3 + 1; }\n",
      );
      await writeFile(
        join(types, "package.json"),
        JSON.stringify({
          name: `@types/${name.startsWith("@") ? "scope__sample" : name}`,
          version: "1.0.0",
          types: "index.d.ts",
        }),
      );
      const declaration = "export function calculate(value: number): number;\n";
      await writeFile(join(types, "index.d.ts"), declaration);
      await writeFile(join(types, "value.d.ts"), declaration);
      await writeFile(
        join(dir, "entry.ts"),
        `import { calculate } from '${name}/value';\nexport function result(): number { return calculate(7); }\n`,
      );
      const profile = {
        profile_format: 1,
        name: "static-types",
        entry: "entry.ts",
        emission: "llvm",
        npm_static: [name],
        abi: {
          prefix: "st_",
          init_symbol: "st_init",
          sink_register_symbol: "st_sink",
          collect_symbol: "st_collect",
        },
        exports: [{ export: "result", symbol: "st_result", params: [], returns: "f64" }],
      };
      const profilePath = join(dir, "profile.json");
      await writeFile(profilePath, JSON.stringify(profile));
      const result = await compileLibrary({ profilePath, outDir: join(dir, "out") });
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      if (process.env["SCRIPTC_PORTABLE_ONLY"] !== "1") {
        const source = join(dir, "host.c"),
          binary = join(dir, "host");
        await writeFile(
          source,
          '#include <stdio.h>\nextern void st_init(void); extern double st_result(void);\nint main(void) { st_init(); printf("%.0f\\n", st_result()); }\n',
        );
        execFileSync("clang", [source, result.archivePath, "-lm", "-o", binary]);
        const actual = execFileSync(binary, { encoding: "utf8" });
        const reference = execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { result } from ${JSON.stringify(join(dir, "entry.ts"))}; console.log(result());`,
          ],
          { encoding: "utf8" },
        );
        expect(actual).toBe(reference);
        expect(actual).toBe("22\n");
      }
      // A dependency the package's JavaScript imports compiles without
      // declarations of its own: no declaration checks that import.
      const dependency = join(dir, "node_modules/unchecked-dependency");
      await mkdir(dependency, { recursive: true });
      await writeFile(
        join(dependency, "package.json"),
        '{"name":"unchecked-dependency","version":"1.0.0","type":"module","main":"index.js"}',
      );
      await writeFile(
        join(dependency, "index.js"),
        "export function adjust(value) { return value; }",
      );
      await writeFile(
        join(pkg, "index.js"),
        "import { adjust } from 'unchecked-dependency'; export function calculate(value) { return adjust(value) * 3 + 1; }\n",
      );
      const withDependency = await compileLibrary({ profilePath, outDir: join(dir, "dependency") });
      if (!withDependency.ok) throw new Error(JSON.stringify(withDependency.diagnostics));
      if (process.env["SCRIPTC_PORTABLE_ONLY"] !== "1") {
        const source = join(dir, "dependency-host.c"),
          binary = join(dir, "dependency-host");
        await writeFile(
          source,
          '#include <stdio.h>\nextern void st_init(void); extern double st_result(void);\nint main(void) { st_init(); printf("%.0f\\n", st_result()); }\n',
        );
        execFileSync("clang", [source, withDependency.archivePath, "-lm", "-o", binary]);
        expect(execFileSync(binary, { encoding: "utf8" })).toBe("22\n");
      }
      expect(await readFile(join(types, "index.d.ts"), "utf8")).toBe(declaration);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
