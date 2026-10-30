import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const bootstrapEntry = join(repoRoot, "packages/cli/dist/bootstrap.js");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");

const glibcHost =
  process.platform === "linux" &&
  typeof (process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } })?.header
    ?.glibcVersionRuntime === "string";

/** Whether the host's clang finds glibc's static C library. */
function hostHasStaticLibc(): boolean {
  try {
    const path = execFileSync("clang", ["-print-file-name=libc.a"], { encoding: "utf8" }).trim();
    return isAbsolute(path) && existsSync(path);
  } catch {
    return false;
  }
}

/** The ELF type and whether the executable names a program interpreter. */
async function elfLinkage(path: string): Promise<{ type: number; interpreter: boolean }> {
  const bytes = await readFile(path);
  const type = bytes.readUInt16LE(16);
  const phoff = Number(bytes.readBigUInt64LE(32));
  const phentsize = bytes.readUInt16LE(54);
  const phnum = bytes.readUInt16LE(56);
  let interpreter = false;
  for (let i = 0; i < phnum; i++) {
    if (bytes.readUInt32LE(phoff + i * phentsize) === 3 /* PT_INTERP */) interpreter = true;
  }
  return { type, interpreter };
}

async function withProject<T>(run: (dir: string, env: NodeJS.ProcessEnv) => Promise<T>) {
  const dir = await mkdtemp(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-static-"),
  );
  try {
    return await run(dir, { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function cli(args: string[], env: NodeJS.ProcessEnv, bootstrap = false) {
  return execFileAsync(
    process.execPath,
    [...(bootstrap ? [bootstrapEntry] : ["--import", tsxLoader, cliEntry]), ...args],
    { env, maxBuffer: 4 * 1024 * 1024 },
  );
}

test.skipIf(!glibcHost || !hostHasStaticLibc())(
  "--static links a glibc executable as static PIE without mixing cache variants",
  async () => {
    await withProject(async (dir, env) => {
      const entry = join(dir, "main.ts");
      const outPath = join(dir, "program");
      // The NSS module file name in a string of the program's own is no lookup.
      await writeFile(
        entry,
        'console.log("static-ok", [1, 2, 3].map((n) => n * 2).join(","), "/lib/libnss_files.so.2");\n',
      );
      const build = async (staticLink: boolean, bootstrap = false) => {
        await cli(
          ["build", entry, "-o", outPath, ...(staticLink ? ["--static"] : [])],
          env,
          bootstrap,
        );
        expect((await execFileAsync(outPath)).stdout).toBe(
          "static-ok 2,4,6 /lib/libnss_files.so.2\n",
        );
        return elfLinkage(outPath);
      };
      // ET_DYN with a program interpreter: the default dynamic PIE link.
      expect(await build(false)).toEqual({ type: 3, interpreter: true });
      // ET_DYN without one: static PIE.
      expect(await build(true)).toEqual({ type: 3, interpreter: false });
      expect(await build(true, true)).toEqual({ type: 3, interpreter: false });
      expect(await build(false, true)).toEqual({ type: 3, interpreter: true });
    });
  },
  180_000,
);

test.skipIf(!glibcHost || !hostHasStaticLibc())(
  "--static refuses a glibc executable that includes user name lookups",
  async () => {
    await withProject(async (dir, env) => {
      const entry = join(dir, "main.ts");
      const outPath = join(dir, "program");
      await writeFile(
        entry,
        'import { userInfo } from "node:os";\nconsole.log(userInfo().username);\n',
      );
      const failure = await cli(["build", entry, "-o", outPath, "--static"], env).then(
        () => null,
        (error: { code?: number; stderr?: string }) => error,
      );
      expect(failure?.code).toBe(1);
      expect(failure?.stderr).toContain("error SC3002: --static cannot link this program");
      expect(existsSync(outPath)).toBe(false);
      // The same program links without --static.
      await cli(["build", entry, "-o", outPath], env);
      expect((await execFileAsync(outPath)).stdout).not.toBe("");
    });
  },
  180_000,
);

test.skipIf(process.platform === "linux")(
  "--static is refused for executables that do not target Linux",
  async () => {
    await withProject(async (dir, env) => {
      const entry = join(dir, "main.ts");
      await writeFile(entry, 'console.log("x");\n');
      const failure = await cli(["build", entry, "-o", join(dir, "program"), "--static"], env).then(
        () => null,
        (error: { code?: number; stderr?: string }) => error,
      );
      expect(failure?.code).toBe(1);
      expect(failure?.stderr).toContain("--static is only supported for Linux executables");
    });
  },
  180_000,
);
