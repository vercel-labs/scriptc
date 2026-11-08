/* The build of scriptc-comptime, the compile-time evaluator every LLVM helper
 * package carries beside the helper: QuickJS-ng, the runtime's port of V8's
 * fdlibm, and comptime.c, from source. Both compilers start this one
 * executable, so each helper package's build script builds it. */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtime = join(here, "../../../packages/runtime");
const quickjs = join(runtime, "vendor/quickjs-ng");
const runtimeSources = join(runtime, "src");

// Zig's C debug mode otherwise inserts UBSan calls into these objects.
const common = ["-g0", "-fno-sanitize=undefined"];
// The engine's flags are the ones its archive in the runtime packs had.
const engineFlags = [
  "-std=gnu11",
  "-Os",
  "-fvisibility=hidden",
  "-funsigned-char",
  "-DQUICKJS_NG_BUILD",
  "-D_GNU_SOURCE",
  "-DNDEBUG",
  "-I",
  quickjs,
];
const units = [
  ...["dtoa.c", "libregexp.c", "libunicode.c", "quickjs.c"].map((name) => ({
    source: join(quickjs, name),
    flags: engineFlags,
  })),
  // The runtime compiles this file with the same flags, and it sets its own
  // floating-point contraction.
  {
    source: join(runtimeSources, "scr_ieee754.c"),
    flags: ["-std=c11", "-O2", "-fno-math-errno", "-fno-strict-aliasing", "-I", runtimeSources],
  },
  {
    source: join(here, "comptime.c"),
    flags: [
      "-std=c11",
      "-O2",
      "-ffp-contract=off",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-I",
      quickjs,
      "-I",
      runtimeSources,
    ],
  },
];

/** Compiles and links the evaluator with `compiler`, a clang-compatible
 * driver and the arguments that select its target (`["clang", "-static"]`,
 * `["zig", "cc", "-target", "x86_64-windows-gnu"]`), keeps its objects in
 * `build`, and writes the stripped executable to `output`. `platform` is the
 * executable's: `linux`, `darwin` or `win32`. The result must run on this
 * host, and is run once to prove it. */
export function buildComptimeEvaluator({ compiler, platform, build, output }) {
  const [command, ...target] = compiler;
  rmSync(build, { recursive: true, force: true });
  mkdirSync(build, { recursive: true });
  mkdirSync(dirname(output), { recursive: true });
  const objects = units.map(({ source, flags }) => {
    const object = join(build, basename(source, ".c") + ".o");
    execFileSync(command, [...target, ...common, ...flags, "-c", source, "-o", object], {
      stdio: "inherit",
    });
    return object;
  });
  execFileSync(
    command,
    [
      ...target,
      ...objects,
      "-lm",
      "-lpthread",
      ...(platform === "darwin" ? ["-Wl,-S,-x"] : ["-Wl,-s"]),
      "-o",
      output,
    ],
    { stdio: "inherit" },
  );
  // The Windows link writes a debug database beside the executable.
  if (platform === "win32") rmSync(output.replace(/\.exe$/, ".pdb"), { force: true });
  const probe = join(build, "probe.js");
  writeFileSync(probe, "Math.hypot(3, 4) + [1, 2].length;\n");
  // A Windows executable ends its line with a carriage return and a line feed.
  const answer = execFileSync(output, [probe, "2000", "64"], { encoding: "utf8" });
  if (answer.trim() !== '["number","7"]')
    throw new Error(`the built comptime evaluator answered ${JSON.stringify(answer)}`);
}
