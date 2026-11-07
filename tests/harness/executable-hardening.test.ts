/* What a release executable carries against a memory-corruption bug, read
 * from the file and from the running process: position independence, no
 * executable stack and no segment both writable and executable, imports
 * bound at load with their table read-only afterwards, no debug payload
 * from the build host, and a small-object heap whose address differs from
 * run to run. Each of these is free while the program runs, so a build that
 * loses one loses it silently; the allocator's own placement checks are in
 * packages/runtime/src/scr_alloc.test.ts. */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/executable-hardening");
const linux = process.platform === "linux";
const glibcHost =
  linux &&
  typeof (process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined)
    ?.header?.glibcVersionRuntime === "string";

const HELLO = `console.log("hello", "world");\n`;
// Keeps a few small objects alive and prints the process's mappings.
const MAPPINGS = `import { readFileSync } from "node:fs";
const kept: string[][] = [];
for (let i = 0; i < 64; i++) kept.push(["item" + i]);
console.log(readFileSync("/proc/self/maps", "utf8"));
console.log(kept.length);
`;

async function build(
  name: string,
  source: string,
  options: { target?: string; optimization?: "release" | "dev" } = {},
): Promise<string> {
  const outDir = join(cacheDir, name);
  const sourcePath = join(outDir, "main.ts");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(sourcePath, source);
  // compile() reads SCRIPTC_TARGET when it is called; the tests of this file
  // run one after another.
  const previous = process.env["SCRIPTC_TARGET"];
  if (options.target === undefined) delete process.env["SCRIPTC_TARGET"];
  else process.env["SCRIPTC_TARGET"] = options.target;
  try {
    const result = await compile(sourcePath, {
      outPath: join(outDir, "program"),
      outDir,
      backend: "llvm",
      ...(options.optimization === undefined ? {} : { optimization: options.optimization }),
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return result.binaryPath;
  } finally {
    if (previous === undefined) delete process.env["SCRIPTC_TARGET"];
    else process.env["SCRIPTC_TARGET"] = previous;
  }
}

async function readelf(flag: string, binary: string): Promise<string> {
  return (await execFileAsync("readelf", [flag, "--wide", binary], { encoding: "utf8" })).stdout;
}

/** One program header row of `readelf --program-headers --wide`: its type
 * and its flags (`R`, `W`, `E`, printed with a space for each one absent). */
function programHeaders(listing: string): { type: string; flags: string; fields: string[] }[] {
  return listing
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => /^0x[0-9a-f]+$/.test(fields[1] ?? "") && fields.length >= 8)
    .map((fields) => ({ type: fields[0]!, flags: fields.slice(6, -1).join(""), fields }));
}

/** The checks every Linux executable passes, whatever its C library. */
async function expectHardenedSegments(binary: string): Promise<void> {
  const headers = programHeaders(await readelf("--program-headers", binary));
  // The stack is not executable, and no loaded segment is both writable
  // and executable.
  expect(headers.filter((h) => h.type === "GNU_STACK").map((h) => h.flags)).toEqual(["RW"]);
  const loaded = headers.filter((h) => h.type === "LOAD");
  expect(loaded.length).toBeGreaterThan(1);
  for (const segment of loaded) expect(segment.flags).not.toBe("RWE");
}

test.runIf(glibcHost)(
  "a glibc executable is position independent and binds its imports at load",
  async () => {
    const hello = await build("hello", HELLO);
    expect((await execFileAsync(hello)).stdout).toBe("hello world\n");
    expect(await readelf("--file-header", hello)).toMatch(/Type:\s+DYN\b/);
    await expectHardenedSegments(hello);
    const dynamic = await readelf("--dynamic", hello);
    // Every import is resolved before the program runs, so the loader makes
    // the whole table of their addresses read-only (GNU_RELRO covers it).
    expect(dynamic).toMatch(/\(FLAGS\)\s+.*\bBIND_NOW\b/);
    expect(dynamic).toMatch(/\(FLAGS_1\)\s+.*\bNOW\b/);
    const sections = await readelf("--section-headers", hello);
    expect(sections).not.toMatch(/\.(?:z?debug_|stab)/);
    const relro = programHeaders(await readelf("--program-headers", hello)).find(
      (h) => h.type === "GNU_RELRO",
    )?.fields;
    if (relro === undefined) throw new Error("the executable has no GNU_RELRO segment");
    const start = BigInt(relro[2]!);
    const end = start + BigInt(relro[5]!);
    for (const name of [".got", ".got.plt"]) {
      const row = sections.split("\n").find((line) => line.includes(`] ${name} `));
      if (row === undefined) continue;
      const address = BigInt(
        `0x${
          row
            .slice(row.indexOf("]") + 1)
            .trim()
            .split(/\s+/)[2]!
        }`,
      );
      expect(address >= start && address < end, `${name} lies in GNU_RELRO`).toBe(true);
    }
  },
);

test.runIf(process.platform === "darwin")(
  "a macOS executable is position independent and binds nothing lazily",
  async () => {
    const hello = await build("hello", HELLO);
    expect((await execFileAsync(hello)).stdout).toBe("hello world\n");
    expect((await execFileAsync("otool", ["-hv", hello])).stdout).toMatch(/\bPIE\b/);
    // dyld applies an executable's chained fixups before the program runs
    // and leaves their segment read-only: there are no lazy symbol pointers
    // for a stray write to redirect, which is what `-z now` and `-z relro`
    // give an ELF executable.
    const commands = (await execFileAsync("otool", ["-l", hello], { maxBuffer: 1 << 24 })).stdout;
    expect(commands).toContain("LC_DYLD_CHAINED_FIXUPS");
    expect(commands).not.toContain("__la_symbol_ptr");
  },
);

test.runIf(linux)(
  "the small-object heap starts at a different address from run to run",
  async () => {
    const program = await build("mappings", MAPPINGS);
    // The window is the one run of 24 GiB of anonymous read-write memory; it
    // starts a whole number of 4 MiB chunks into [4 GiB, 8 GiB). Where the
    // kernel writes cores (RLIMIT_CORE above 0, or a core_pattern piping to a
    // handler), the allocator makes each chunk it carves dumpable again with
    // madvise, which splits the window into adjacent mappings: a run is the
    // mappings that follow each other with no gap.
    const windowStart = async (command: string, args: string[]): Promise<bigint> => {
      const { stdout } = await execFileAsync(command, args, { maxBuffer: 1 << 24 });
      const runs: { lo: bigint; hi: bigint }[] = [];
      for (const line of stdout.split("\n")) {
        const mapping = /^([0-9a-f]+)-([0-9a-f]+) rw-p 0+ 00:00 0\s*$/.exec(line);
        if (mapping === null) continue;
        const [lo, hi] = [BigInt(`0x${mapping[1]}`), BigInt(`0x${mapping[2]}`)];
        const last = runs.at(-1);
        if (last !== undefined && last.hi === lo) last.hi = hi;
        else runs.push({ lo, hi });
      }
      const starts = runs.filter((run) => run.hi - run.lo === 24n << 30n).map((run) => run.lo);
      expect(starts, "one window").toHaveLength(1);
      return starts[0]!;
    };
    const starts: bigint[] = [];
    for (let run = 0; run < 8; run++) starts.push(await windowStart(program, []));
    for (const start of starts) {
      expect(start >= 4n << 30n && start < 8n << 30n, start.toString(16)).toBe(true);
      expect(start % (4n << 20n)).toBe(0n);
    }
    // Eight equal draws of 1024 happen once in 10^21 runs.
    expect(new Set(starts).size).toBeGreaterThan(1);
    // A process whose address-space randomization is off keeps the lowest
    // start, as debuggers start programs. A seccomp filter may refuse the
    // personality (Docker's default does): nothing to check there.
    const fixed = await execFileAsync("setarch", ["-R", "true"]).then(
      () => true,
      () => false,
    );
    if (fixed)
      for (let run = 0; run < 3; run++)
        expect(await windowStart("setarch", ["-R", program])).toBe(4n << 30n);
  },
);

// The musl runtime pack is built by its own CI job (build:native); the test
// runs wherever the pack and zig, which links it, are present.
const muslArch = process.arch === "arm64" ? "aarch64" : "x86_64";
const muslPack = join(
  repoRoot,
  `packages/runtime-linux-${process.arch === "arm64" ? "arm64" : "x64"}-musl/runtime-pack.json`,
);
function zigOnPath(): boolean {
  try {
    execFileSync("zig", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const muslBuilds = linux && existsSync(muslPack) && zigOnPath();

test.runIf(muslBuilds)(
  "a musl release executable carries no debug payload of the build host",
  // A zig link now and then exits with success and no output file (3 of 35
  // musl links in one Sandbox session, the base compiler's among them); the
  // build then fails with SC3004, which is not what this test is about.
  { retry: 2 },
  async () => {
    const target = `${muslArch}-linux-musl`;
    const hello = await build("hello-musl", HELLO, { target });
    expect((await execFileAsync(hello)).stdout).toBe("hello world\n");
    await expectHardenedSegments(hello);
    expect(await readelf("--section-headers", hello)).not.toMatch(/\.(?:z?debug_|stab)/);
    // zig's musl objects name its installation and cache directories in
    // their DWARF, and the link's temporary directory with them.
    const bytes = readFileSync(hello);
    for (const path of ["libc/musl/src", ".scriptc-runtime-pack-link-"])
      expect(bytes.includes(path), `the executable names ${path}`).toBe(false);
    // Well under the megabyte and a half the debug info of musl took.
    expect(bytes.length).toBeLessThan(256 * 1024);

    // A dev executable keeps debug info, the program's line tables included.
    const dev = await build("hello-musl-dev", HELLO, { target, optimization: "dev" });
    expect((await execFileAsync(dev)).stdout).toBe("hello world\n");
    expect(await readelf("--section-headers", dev)).toMatch(/\.debug_line/);
  },
);
