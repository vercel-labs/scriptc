import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);
// The scenarios need GNU ld linker scripts and thin archives, which the
// Darwin linker and archiver do not have.
const linux = process.platform === "linux";
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function object(dir: string, name: string, symbol: string, value: number): Promise<string> {
  const source = join(dir, `${name}.c`);
  const path = join(dir, `${name}.o`);
  await writeFile(source, `double ${symbol}(void) { return ${value}; }\n`);
  await execFileAsync("clang", ["-c", source, "-o", path]);
  return path;
}

async function publishedStamps(cache: string) {
  const names = (await readdir(join(cache, "early-exe"), { recursive: true })).filter((path) =>
    path.endsWith("stamp.json"),
  );
  return Promise.all(
    names.map(
      async (name) =>
        JSON.parse(await readFile(join(cache, "early-exe", name), "utf8")) as {
          files: { executable: { name: string } | null };
          nativeDependencies: { path: string }[] | null;
        },
    ),
  );
}

const entryText = [
  "declare function nativeValue(): number;",
  "console.log(nativeValue());",
  "",
].join("\n");

function profileText(libraries: string[]): string {
  return JSON.stringify({
    ffi_format: 1,
    functions: [
      { name: "nativeValue", symbol: "scriptc_link_input_probe", params: [], returns: "f64" },
    ],
    libraries,
    system_libraries: [],
  });
}

describe.skipIf(!linux)("FFI link inputs the trace cannot name", () => {
  test("an included linker script's new input is linked, not the cached executable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-ffi-script-cache-"));
    dirs.push(dir);
    const cache = join(dir, "cache");
    const entry = join(dir, "main.ts");
    const profile = join(dir, "ffi.json");
    const script = join(dir, "library.ld");
    const included = join(dir, "select.ld");
    const output = join(dir, "program");
    const first = await object(dir, "first", "scriptc_link_input_probe", 7);
    const second = await object(dir, "second", "scriptc_link_input_probe", 9);
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    try {
      await writeFile(entry, entryText);
      // The profile's library is a script, and the object it links comes from
      // a script that script includes: the driver's trace names neither.
      await writeFile(script, `INCLUDE "${included}"\n`);
      await writeFile(included, `INPUT ( ${first} )\n`);
      await writeFile(profile, profileText([script]));
      process.env["SCRIPTC_CACHE_DIR"] = cache;
      delete process.env["SCRIPTC_NO_CACHE"];
      const options = {
        outDir: dir,
        outPath: output,
        backend: "llvm" as const,
        ffiProfilePath: profile,
      };

      const built = await compile(entry, options);
      if (!built.ok) throw new Error(built.diagnostics.map((d) => d.message).join("\n"));
      expect((await execFileAsync(output, [], { encoding: "utf8" })).stdout.trim()).toBe("7");

      const published = (await publishedStamps(cache)).filter(
        (stamp) => stamp.files.executable !== null,
      );
      expect(published).toHaveLength(1);
      const dependencies = published[0]!.nativeDependencies?.map((item) => item.path) ?? [];

      // The same script spelling now selects another object.
      await writeFile(included, `INPUT ( ${second} )\n`);
      const rebuilt = await compile(entry, options);
      if (!rebuilt.ok) throw new Error(rebuilt.diagnostics.map((d) => d.message).join("\n"));
      expect((await execFileAsync(output, [], { encoding: "utf8" })).stdout.trim()).toBe("9");

      // The proof covers the included script and the object it names.
      expect(dependencies).toContain(included);
      expect(dependencies).toContain(first);
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    }
  });

  test("a rebuilt member of a thin archive is linked, not the cached executable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-ffi-thin-cache-"));
    dirs.push(dir);
    const cache = join(dir, "cache");
    const entry = join(dir, "main.ts");
    const profile = join(dir, "ffi.json");
    const library = join(dir, "libscriptc_link_input_probe.a");
    const output = join(dir, "program");
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    try {
      await writeFile(entry, entryText);
      await object(dir, "member", "scriptc_link_input_probe", 7);
      // A thin archive stores its member's path, not its bytes, so the archive
      // stays identical when the member is rebuilt.
      await execFileAsync("ar", ["crsT", library, "member.o"], { cwd: dir });
      await writeFile(profile, profileText([library]));
      process.env["SCRIPTC_CACHE_DIR"] = cache;
      delete process.env["SCRIPTC_NO_CACHE"];
      const options = {
        outDir: dir,
        outPath: output,
        backend: "llvm" as const,
        ffiProfilePath: profile,
      };

      const built = await compile(entry, options);
      if (!built.ok) throw new Error(built.diagnostics.map((d) => d.message).join("\n"));
      expect((await execFileAsync(output, [], { encoding: "utf8" })).stdout.trim()).toBe("7");

      const published = (await publishedStamps(cache)).filter(
        (stamp) => stamp.files.executable !== null,
      );
      expect(published).toHaveLength(1);
      const dependencies = published[0]!.nativeDependencies?.map((item) => item.path) ?? [];

      await object(dir, "member", "scriptc_link_input_probe", 9);
      const rebuilt = await compile(entry, options);
      if (!rebuilt.ok) throw new Error(rebuilt.diagnostics.map((d) => d.message).join("\n"));
      expect((await execFileAsync(output, [], { encoding: "utf8" })).stdout.trim()).toBe("9");

      // The proof names the archive and the member the archive stands for.
      expect(dependencies).toContain(library);
      expect(dependencies).toContain(join(dir, "member.o"));
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    }
  });
});
