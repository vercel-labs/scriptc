import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { rollup } from "rollup";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const hasZig = spawnSync("zig", ["version"], { stdio: "ignore" }).status === 0;
const require = createRequire(import.meta.url);
const wasiRunner = `const {WASI}=require('node:wasi'); const {readFileSync}=require('node:fs');
const wasi=new WASI({version:'preview1',args:[process.argv[1]],returnOnExit:true});
const instance=new WebAssembly.Instance(new WebAssembly.Module(readFileSync(process.argv[1])),wasi.getImportObject());
process.exitCode=wasi.start(instance);`;
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  if (result.error) throw result.error;
  const stderr = result.stderr
    .split("\n")
    .filter((line) => !line.startsWith("scriptc RC audit skipped:"))
    .join("\n");
  return { stdout: result.stdout, stderr, status: result.status, signal: result.signal };
}

const cases = [
  "three/collision.mjs",
  "three/buffers-animation.mjs",
  "npm-static/array-output-parameters.mjs",
].flatMap((fixture) => ["native", "wasm32-wasi"].map((target) => ({ fixture, target })));
test.for(cases)(
  "published $fixture runs statically on $target",
  // Bundling three.js and building it with the sanitizer can pass the
  // default 300 s on a busy runner, as in three.test.ts.
  { timeout: 1_200_000 },
  async ({ fixture, target }, context) => {
    if (target === "wasm32-wasi" && !hasZig) context.skip();
    const dir = await mkdtemp("/tmp/scriptc-spatial-");
    const previousTarget = process.env["SCRIPTC_TARGET"],
      previousCc = process.env["SCRIPTC_CC"];
    try {
      if (target === "wasm32-wasi") {
        process.env["SCRIPTC_TARGET"] = target;
        process.env["SCRIPTC_CC"] = "zigcc";
      }
      const pkg = join(dir, "node_modules", "spatial-fixture");
      await mkdir(pkg, { recursive: true });
      await writeFile(
        join(pkg, "package.json"),
        '{"name":"spatial-fixture","type":"module","main":"index.js"}',
      );
      const entry = join(dir, "main.mjs");
      await writeFile(entry, 'import "spatial-fixture";');
      const source = join(import.meta.dirname, "../fixtures", fixture);
      const bundle = await rollup({
        input: source,
        plugins: [
          {
            name: "three-cpu-entry",
            resolveId(id) {
              if (id === "three") return require.resolve("three/src/Three.Core.js");
              if (id.startsWith("three/")) return require.resolve(id);
              return null;
            },
          },
        ],
      });
      try {
        await bundle.write({ file: join(pkg, "index.js"), format: "es" });
      } finally {
        await bundle.close();
      }
      const wasm = target === "wasm32-wasi";
      const output = join(dir, wasm ? "program.wasm" : "program");
      const result = await compile(entry, {
        outDir: dir,
        outPath: output,
        backend: "llvm",
        npmStatic: ["spatial-fixture"],
        sanitize: !wasm && process.env["SCRIPTC_SAN"] === "1",
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      if (wasm) expect([...(await readFile(output)).subarray(0, 4)]).toEqual([0, 97, 115, 109]);
      const reference = run(process.execPath, ["--no-warnings", source]);
      expect(reference.status).toBe(0);
      expect(run(process.execPath, ["--no-warnings", entry])).toEqual(reference);
      expect(
        wasm ? run(process.execPath, ["--no-warnings", "-e", wasiRunner, output]) : run(output, []),
      ).toEqual(reference);
    } finally {
      if (previousTarget === undefined) delete process.env["SCRIPTC_TARGET"];
      else process.env["SCRIPTC_TARGET"] = previousTarget;
      if (previousCc === undefined) delete process.env["SCRIPTC_CC"];
      else process.env["SCRIPTC_CC"] = previousCc;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
