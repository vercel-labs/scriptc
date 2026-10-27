import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  LINUX_ARM64_GNU_TARGET,
  LINUX_X64_GNU_TARGET,
  MACOS_ARM64_TARGET,
  type NativeTargetSpec,
} from "../backend/targets.js";
import { NativeCache } from "./cache.js";
import { LinkerJobs } from "./linker-job.js";
import type { NativeToolchain } from "./toolchain.js";

const directories: string[] = [];
const saved = new Map<string, string | undefined>();
const variables = [
  "SCRIPTC_LINKER",
  "COMPILER_PATH",
  "LOG",
  "LD",
  "CRT",
  "LIB",
  "FAIL",
  "BROKEN",
  "DOUBLE",
];
beforeEach(() => {
  for (const name of variables) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
});
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function script(path: string, text: string): string {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
  return path;
}

/** A driver named `name` and an ld.lld that log their arguments to $LOG. The
 * driver's job runs $LD with `-pie`, the startup object $CRT, `-L$LIB` and
 * its own arguments (without `-fuse-ld=lld` and `-v`, `-Wl,` removed). With
 * -### it prints that job as clang does, every argument quoted; with -v it
 * prints the job it runs as clang does, only the program quoted. With
 * $BROKEN, -### prints the job twice; with $DOUBLE, it names the path $DOUBLE
 * once more. The linker writes its inputs to its output, prints them with
 * `-t`, and fails with $FAIL. */
function fixture(name = "clang") {
  const root = mkdtempSync(join(tmpdir(), "scriptc-linker-job-"));
  directories.push(root);
  const bin = join(root, "bin");
  const lib = join(root, "lib");
  // The recorded inputs include the parents of the toolchain's paths (here
  // `root`); stages are elsewhere, as a build's are.
  const stages = join(root, "stages");
  for (const directory of [bin, lib, stages]) mkdirSync(directory);
  const log = join(root, "log");
  writeFileSync(log, "");
  const driver = script(
    join(bin, name),
    `#!/bin/sh
echo "driver $*" >> "$LOG"
job=" \\"$LD\\" \\"-pie\\" \\"$CRT\\" \\"-L$LIB\\""
raw=" \\"$LD\\" -pie $CRT -L$LIB"
listing=0; verbose=0
for a; do
  case "$a" in
    -'###') listing=1 ;;
    -v) verbose=1 ;;
    -fuse-ld=lld) ;;
    -Wl,*) job="$job \\"\${a#-Wl,}\\""; raw="$raw \${a#-Wl,}" ;;
    *) job="$job \\"$a\\""; raw="$raw $a" ;;
  esac
done
if [ $listing = 1 ]; then
  echo "InstalledDir: $(dirname "$0")" >&2
  [ -z "$DOUBLE" ] && echo "$job" >&2
  [ -n "$BROKEN" ] && echo "$job" >&2
  [ -n "$DOUBLE" ] && echo "$job \\"$DOUBLE\\"" >&2 && exit 0
  exit 0
fi
[ $verbose = 1 ] && echo "$raw" >&2
eval "exec $job"
`,
  );
  const ld = script(
    join(bin, "ld.lld"),
    `#!/bin/sh
echo "ld.lld $*" >> "$LOG"
[ -n "$FAIL" ] && exit 1
out=""; prev=""
for a; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
printf '%s\\n' "$@" > "$out"
for a; do [ "$a" = "-t" ] && printf '%s\\n' "$@" | grep '^/'; done
exit 0
`,
  );
  const crt = join(lib, "Scrt1.o");
  writeFileSync(crt, "startup object");
  Object.assign(process.env, { LOG: log, LD: ld, CRT: crt, LIB: lib });
  // A directory's identity is its stat: an old time makes a later change visible.
  utimesSync(lib, 0, 0);
  const cache = new NativeCache(join(root, "cache"));
  const toolchain = (target: NativeTargetSpec = LINUX_X64_GNU_TARGET, helper = target) =>
    ({
      target,
      helper: helper.helper,
      linker: driver,
    }) as unknown as NativeToolchain;
  let count = 0;
  /** A stage with a program object, the link's paths and its driver arguments. */
  const stage = () => {
    const directory = join(stages, `stage-${++count}`);
    mkdirSync(directory);
    const program = join(directory, "program.o");
    const output = join(directory, "out");
    writeFileSync(program, "program");
    return {
      directory,
      output,
      paths: [program, output],
      args: ["-fuse-ld=lld", "-pthread", program, "-lm", "-o", output],
    };
  };
  const calls = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line !== "");
  return { root, bin, lib, crt, ld, driver, cache, toolchain, stage, calls };
}

test.skipIf(process.platform === "win32")(
  "a link records the driver's job once, and later links run ld.lld with their own paths",
  () => {
    const f = fixture();
    const jobs = LinkerJobs.open(f.cache, f.toolchain(), ["-fuse-ld=lld"], false)!;
    expect(jobs).not.toBeNull();
    const first = f.stage();
    const run = jobs.run(first.args, first.paths, first.directory, true);
    expect(run).not.toBeNull();
    // The driver only listed the job; ld.lld linked.
    expect(f.calls()).toEqual([
      `driver ${first.args.join(" ")} -v -###`,
      `ld.lld -pie ${f.crt} -L${f.lib} -pthread ${first.paths[0]} -lm -o ${first.output}`,
    ]);
    expect(readFileSync(first.output, "utf8")).toContain(first.paths[0]);
    const recorded = run!.driverInputs.map((input) => input.path);
    expect(recorded).toEqual(expect.arrayContaining([f.ld, f.bin, f.crt, f.lib]));
    expect(recorded.some((path) => path.startsWith(first.directory))).toBe(false);
    // Another build, with other paths, runs the recorded job without the driver.
    const second = f.stage();
    const again = LinkerJobs.open(f.cache, f.toolchain(), ["-fuse-ld=lld"], false)!;
    expect(again.run(second.args, second.paths, second.directory, true)).not.toBeNull();
    expect(f.calls().slice(2)).toEqual([
      `ld.lld -pie ${f.crt} -L${f.lib} -pthread ${second.paths[0]} -lm -o ${second.output}`,
    ]);
    // Other arguments are another job.
    const third = f.stage();
    expect(
      again.run([...third.args, "-Wl,-t"], third.paths, third.directory, true)?.output,
    ).toContain(third.paths[0]);
    expect(f.calls().slice(3)[0]).toBe(`driver ${third.args.join(" ")} -Wl,-t -v -###`);
  },
);

test.skipIf(process.platform === "win32")(
  "a driver link records its job from its -v output, and later links run it",
  () => {
    const f = fixture();
    const open = () => LinkerJobs.open(f.cache, f.toolchain(), ["-fuse-ld=lld"], false)!;
    const first = f.stage();
    const traced = [...first.args, "-v", "-Wl,-t"];
    // Without an entry, a link that is not listed runs through the driver.
    const link = open().link(first.paths, first.directory);
    expect(link.run(traced, false)).toBeNull();
    expect(f.calls()).toEqual([]);
    const linked = spawnSync(f.driver, traced, { encoding: "utf8" });
    expect(linked.status).toBe(0);
    link.record(traced, linked.stdout + "\n" + linked.stderr);
    const second = f.stage();
    const run = open()
      .link(second.paths, second.directory)
      .run([...second.args, "-v", "-Wl,-t"], false);
    expect(run?.output).toContain(second.paths[0]);
    expect(run!.driverInputs.map((input) => input.path)).toEqual(
      expect.arrayContaining([f.ld, f.bin, f.crt, f.lib]),
    );
    expect(f.calls().slice(2)).toEqual([
      `ld.lld -pie ${f.crt} -L${f.lib} -pthread ${second.paths[0]} -lm -o ${second.output} -t`,
    ]);
  },
);

test.skipIf(process.platform === "win32")(
  "a changed startup object, library directory or linker sends the link to the driver",
  () => {
    for (const change of ["crt", "lib", "ld"] as const) {
      const f = fixture();
      const open = () => LinkerJobs.open(f.cache, f.toolchain(), ["-fuse-ld=lld"], false)!;
      const first = f.stage();
      expect(open().run(first.args, first.paths, first.directory, true)).not.toBeNull();
      if (change === "lib") writeFileSync(join(f.lib, "libm.so"), "new library");
      else {
        const path = change === "crt" ? f.crt : f.ld;
        const before = statSync(path);
        writeFileSync(path + ".new", readFileSync(path));
        chmodSync(path + ".new", 0o755);
        utimesSync(path + ".new", before.atime, before.mtime);
        renameSync(path + ".new", path);
      }
      const second = f.stage();
      const count = f.calls().length;
      expect(open().run(second.args, second.paths, second.directory, true)).toBeNull();
      expect(f.calls().length).toBe(count);
    }
  },
);

test.skipIf(process.platform === "win32")("a changed driver records the job again", () => {
  const f = fixture();
  const first = f.stage();
  expect(
    LinkerJobs.open(f.cache, f.toolchain(), ["-fuse-ld=lld"], false)!.run(
      first.args,
      first.paths,
      first.directory,
      true,
    ),
  ).not.toBeNull();
  writeFileSync(f.driver, readFileSync(f.driver, "utf8") + "\n");
  const second = f.stage();
  expect(
    LinkerJobs.open(f.cache, f.toolchain(), ["-fuse-ld=lld"], false)!.run(
      second.args,
      second.paths,
      second.directory,
      true,
    ),
  ).not.toBeNull();
  expect(f.calls()[2]).toBe(`driver ${second.args.join(" ")} -v -###`);
});

test.skipIf(process.platform === "win32")(
  "a job that fails sends this and the build's later links to the driver",
  () => {
    const f = fixture();
    const first = f.stage();
    const open = () => LinkerJobs.open(f.cache, f.toolchain(), ["-fuse-ld=lld"], false)!;
    expect(open().run(first.args, first.paths, first.directory, true)).not.toBeNull();
    process.env["FAIL"] = "1";
    const jobs = open();
    const second = f.stage();
    expect(jobs.run(second.args, second.paths, second.directory, true)).toBeNull();
    const count = f.calls().length;
    expect(jobs.run(second.args, second.paths, second.directory, true)).toBeNull();
    expect(f.calls().length).toBe(count);
  },
);

test.skipIf(process.platform === "win32")(
  "a listing without one ld.lld job naming each path once keeps the driver, and is not asked again",
  () => {
    for (const listing of ["two jobs", "another linker", "a path twice"] as const) {
      const f = fixture();
      if (listing === "two jobs") process.env["BROKEN"] = "1";
      if (listing === "another linker")
        process.env["LD"] = script(join(f.bin, "ld.bfd"), readFileSync(f.ld, "utf8"));
      const open = () => LinkerJobs.open(f.cache, f.toolchain(), ["-fuse-ld=lld"], false)!;
      const first = f.stage();
      if (listing === "a path twice") process.env["DOUBLE"] = first.paths[0];
      expect(open().run(first.args, first.paths, first.directory, true)).toBeNull();
      expect(f.calls()).toEqual([`driver ${first.args.join(" ")} -v -###`]);
      // The answer is stored: the next build does not list the job again.
      expect(open().run(first.args, first.paths, first.directory, true)).toBeNull();
      expect(f.calls().length).toBe(1);
      delete process.env["BROKEN"];
      delete process.env["DOUBLE"];
    }
  },
);

test.skipIf(process.platform === "win32")(
  "arguments that name the stage besides the link's paths keep the driver",
  () => {
    const f = fixture();
    const first = f.stage();
    const jobs = LinkerJobs.open(f.cache, f.toolchain(), ["-fuse-ld=lld"], false)!;
    const script = `-Wl,--version-script=${join(first.directory, "exports")}`;
    expect(jobs.run([...first.args, script], first.paths, first.directory, true)).toBeNull();
    expect(f.calls()).toEqual([]);
  },
);

test.skipIf(process.platform === "win32")(
  "only host Linux links through a clang driver with lld run the job",
  () => {
    const f = fixture();
    const lld = ["-fuse-ld=lld"];
    expect(LinkerJobs.open(f.cache, f.toolchain(), lld, false)).not.toBeNull();
    // A cross-target link: the arm64 target with the x64 host's helper.
    expect(
      LinkerJobs.open(
        f.cache,
        f.toolchain(LINUX_ARM64_GNU_TARGET, LINUX_X64_GNU_TARGET),
        lld,
        false,
      ),
    ).toBeNull();
    expect(
      LinkerJobs.open(
        f.cache,
        f.toolchain(LINUX_X64_GNU_TARGET, LINUX_ARM64_GNU_TARGET),
        lld,
        false,
      ),
    ).toBeNull();
    expect(LinkerJobs.open(f.cache, f.toolchain(MACOS_ARM64_TARGET), lld, false)).toBeNull();
    // The driver's default linker, a sanitizer link, no cache.
    expect(LinkerJobs.open(f.cache, f.toolchain(), [], false)).toBeNull();
    expect(LinkerJobs.open(f.cache, f.toolchain(), lld, true)).toBeNull();
    expect(LinkerJobs.open(null, f.toolchain(), lld, false)).toBeNull();
    // A linker that is not a clang driver.
    const gcc = fixture("gcc");
    expect(LinkerJobs.open(gcc.cache, gcc.toolchain(), lld, false)).toBeNull();
    // An explicit linker, or an environment that names mutable toolchain inputs.
    process.env["SCRIPTC_LINKER"] = f.driver;
    expect(LinkerJobs.open(f.cache, f.toolchain(), lld, false)).toBeNull();
    delete process.env["SCRIPTC_LINKER"];
    process.env["COMPILER_PATH"] = f.bin;
    expect(LinkerJobs.open(f.cache, f.toolchain(), lld, false)).toBeNull();
  },
);

const hostTarget =
  process.arch === "x64"
    ? LINUX_X64_GNU_TARGET
    : process.arch === "arm64"
      ? LINUX_ARM64_GNU_TARGET
      : null;
const hasLld =
  process.platform === "linux" &&
  spawnSync("clang", ["-fuse-ld=lld", "-###", "-x", "c", "/dev/null"], {
    encoding: "utf8",
  }).stderr?.includes("ld.lld") === true;

test.skipIf(hostTarget === null || !hasLld)("the job links the executable the driver links", () => {
  const root = mkdtempSync(join(tmpdir(), "scriptc-linker-job-clang-"));
  directories.push(root);
  const stage = join(root, "stage");
  mkdirSync(stage);
  const program = join(stage, "program.o");
  const compiled = spawnSync("clang", ["-c", "-x", "c", "-", "-o", program], {
    input: '#include <stdio.h>\nint main(void) { puts("linked"); return 0; }\n',
  });
  expect(compiled.status).toBe(0);
  const toolchain = {
    target: hostTarget,
    helper: hostTarget!.helper,
    linker: "clang",
  } as unknown as NativeToolchain;
  const args = (output: string) => ["-fuse-ld=lld", "-pthread", program, "-lm", "-o", output];
  const viaDriver = join(stage, "driver");
  expect(spawnSync("clang", args(viaDriver)).status).toBe(0);
  const cache = new NativeCache(join(root, "cache"));
  // Recorded from the -v output of a traced link, and listed with -###.
  const traced = (output: string) => [...args(output), "-v", "-Wl,-t"];
  const tracedOutput = join(stage, "traced");
  const linked = spawnSync("clang", traced(tracedOutput), { encoding: "utf8" });
  expect(linked.status).toBe(0);
  LinkerJobs.open(cache, toolchain, ["-fuse-ld=lld"], false)!
    .link([program, tracedOutput], stage)
    .record(traced(tracedOutput), linked.stdout + "\n" + linked.stderr);
  for (const [name, list] of [
    ["first", false],
    ["second", true],
    ["third", true],
  ] as const) {
    const output = join(stage, name);
    const link = LinkerJobs.open(cache, toolchain, ["-fuse-ld=lld"], false)!.link(
      [program, output],
      stage,
    );
    const run = list ? link.run(args(output), true) : link.run(traced(output), false);
    expect(run).not.toBeNull();
    expect(readFileSync(output).equals(readFileSync(viaDriver))).toBe(true);
    expect(spawnSync(output, { encoding: "utf8" }).stdout).toBe("linked\n");
  }
});
