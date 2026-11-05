import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compileLibrary } from "@scriptc/compiler";
import { beforeEach, describe, expect, test } from "vitest";
import { skipUnownedTest } from "./shard.js";

const fixture = join(import.meta.dirname, "../library-mode/wasm");
const hasClang = spawnSync("clang", ["--version"]).status === 0;
// Release compiles the whole three.js library into one LLVM module that a
// single process optimizes and codegens on one core, which takes 5-10
// minutes; sanitized dev builds are slower still. Lanes measured 331-581s for
// release against the old 600s budget, so both get 1_200_000ms. The plain dev
// case runs at about a fifth of release and keeps 600_000ms.
function timeoutFor(optimization: "dev" | "release"): number {
  return optimization === "release" || process.env["SCRIPTC_SAN"] === "1" ? 1_200_000 : 600_000;
}
// The two optimizations take similar time (about 10 minutes each under ASan):
// SCRIPTC_TEST_SHARD runs them on different shards (tests/harness/shard.ts).
// skipUnownedTest partitions a describe block's tests.
describe("three.js native library", () => {
  beforeEach((context) => skipUnownedTest(context, {}));
  for (const optimization of ["dev", "release"] as const) {
    test.skipIf(!hasClang)(
      `three.js sends animated geometry, materials and resource lifecycle to a native host in ${optimization}`,
      async () => {
        const directory = await mkdtemp("/tmp/scriptc-three-library-");
        const sanitize = process.env["SCRIPTC_SAN"] === "1";
        try {
          const profile = JSON.parse(await readFile(join(fixture, "three.json"), "utf8"));
          const profilePath = join(directory, "profile.json");
          await writeFile(
            profilePath,
            JSON.stringify({
              ...profile,
              name: "three-native-embedding",
              entry: join(fixture, "three.mjs"),
              optimization,
            }),
          );
          const built = await compileLibrary({ profilePath, outDir: directory, sanitize });
          if (!built.ok)
            throw new Error(
              built.diagnostics
                .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
                .join("\n"),
            );
          const binary = join(directory, "host");
          const linked = spawnSync(
            "clang",
            [
              "-std=c11",
              ...(sanitize ? ["-fsanitize=address,undefined"] : []),
              join(fixture, "three-native.c"),
              built.archivePath,
              "-lm",
              "-o",
              binary,
            ],
            { encoding: "utf8" },
          );
          expect(linked.status, linked.stderr).toBe(0);
          const actual = spawnSync(binary, [], { encoding: "utf8", timeout: 30_000 });
          expect(actual.status, actual.stderr).toBe(0);
          const reference = spawnSync(
            process.execPath,
            [
              "--no-warnings",
              "--input-type=module",
              "-e",
              `
      const events=[];
      for (const name of ["vertex","surface","resource"]) globalThis[name]=(...values)=>events.push([name,...values.map(value=>Number(value.toFixed(9)))]);
      const {frame,dispose}=await import(${JSON.stringify(join(fixture, "three.mjs"))});
      for (const time of [0,123,2000]) frame(time,1.5);
      dispose();
      console.log(JSON.stringify(events));
    `,
            ],
            { encoding: "utf8" },
          );
          expect(reference.status, reference.stderr).toBe(0);
          const events = JSON.parse(reference.stdout);
          expect(
            actual.stdout
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)),
          ).toEqual([...events, ...events]);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
      timeoutFor(optimization),
    );
  }
});
