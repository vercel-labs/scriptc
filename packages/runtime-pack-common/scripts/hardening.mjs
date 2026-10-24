import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const ZERO_INIT = ["-ftrivial-auto-var-init=zero", "-ftrivial-auto-var-init-max-size=64"];

/**
 * Hardening flags for the precompiled C runtime units and for the vendored
 * zlib and mbedtls archives, which parse untrusted compressed and network
 * input.
 *
 * Generated code is checked by the compiler; the C runtime is trusted. These
 * flags turn some classes of runtime memory bugs into deterministic traps or
 * defined values instead of silent corruption. None changes the behavior of
 * a correct program.
 *
 * - `-ftrivial-auto-var-init=zero` zero-initializes automatic variables of up
 *   to 64 bytes, so an uninitialized scalar, pointer or small struct reads as
 *   zero rather than stale stack contents. Larger buffers stay uninitialized:
 *   without the size limit, the HTTP server benchmark ran 11% slower. A
 *   compiler without `-ftrivial-auto-var-init-max-size` (the Android NDK 27
 *   clang) gets no zero-initialization at all rather than the unlimited form
 *   (`cappedZeroInit`, from `probeHardeningSupport`).
 * - `-fsanitize=bounds -fsanitize-trap=bounds` traps on out-of-bounds indexing
 *   of arrays whose bound the compiler knows. Trapping needs no sanitizer
 *   runtime, so the artifacts still exclude every `__ubsan_` handler.
 *   Unoptimized (dev) units use only the `local-bounds` part: clang's
 *   `array-bounds` checks emit sanitizer metadata even when they trap, and
 *   without optimization that unused metadata stays in the object, including
 *   source paths that `-ffile-prefix-map` does not rewrite (the file name and
 *   the location of every unnamed struct). `local-bounds` is checked in LLVM
 *   IR and embeds nothing.
 * - `-fstack-protector-strong` adds stack canaries. WASM keeps return
 *   addresses off the linear-memory stack, so it gets no canaries.
 * - `-fstack-clash-protection` probes large stack allocations on Linux.
 *   Darwin and Windows toolchains already probe large frames, and WASM has no
 *   guard page to jump.
 * - `_FORTIFY_SOURCE=2` checks libc string and memory calls against object
 *   sizes known at compile time. It requires optimization and a libc that
 *   implements it (glibc, Darwin, Bionic and MinGW); musl and wasi-libc ignore
 *   it. Level 3, which also checks dynamically computed sizes, made the
 *   regex benchmark 5% slower.
 *
 * QuickJS and libregexp keep their existing flags: hardening them as well
 * slowed the regex, CSV-number and error-validation benchmarks by 5-7%.
 */
export function runtimeHardeningFlags(config, { optimized, cappedZeroInit }) {
  if (typeof cappedZeroInit !== "boolean") {
    throw new Error("runtimeHardeningFlags requires the probed cappedZeroInit support");
  }
  const platform = config.platform;
  const wasi = platform === "wasi";
  const musl = (config.runtimeDefines ?? []).includes("SCR_MUSL");
  return [
    ...(cappedZeroInit ? ZERO_INIT : []),
    ...(optimized
      ? ["-fsanitize=bounds", "-fsanitize-trap=bounds"]
      : ["-fsanitize=local-bounds", "-fsanitize-trap=local-bounds"]),
    ...(wasi ? [] : ["-fstack-protector-strong"]),
    ...(platform === "linux" ? ["-fstack-clash-protection"] : []),
    ...(optimized && !wasi && !musl ? ["-U_FORTIFY_SOURCE", "-D_FORTIFY_SOURCE=2"] : []),
  ];
}

/**
 * Reports which optional hardening flags the pack's compiler accepts, by
 * compiling an empty translation unit with them. `args` are the arguments
 * that select the compiler mode and target (for example `cc -target ...`).
 */
export async function probeHardeningSupport({ compiler, args = [] }) {
  const root = await mkdtemp(join(tmpdir(), "scriptc-hardening-probe-"));
  try {
    const source = join(root, "probe.c");
    await writeFile(source, "int scriptc_hardening_probe;\n");
    const compile = (flags) =>
      run(compiler, [...args, ...flags, "-c", source, "-o", join(root, "probe.o")], { cwd: root });
    // A probe that cannot compile at all must not read as missing support.
    await compile([]);
    const accepts = async (flags) => {
      try {
        await compile(flags);
        return true;
      } catch {
        return false;
      }
    };
    return { cappedZeroInit: await accepts(ZERO_INIT) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
