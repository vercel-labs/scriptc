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
 *   without the size limit, the HTTP server benchmark ran 11% slower.
 * - `-fsanitize=bounds -fsanitize-trap=bounds` traps on out-of-bounds indexing
 *   of arrays whose bound the compiler knows. Trapping needs no sanitizer
 *   runtime, so the artifacts still exclude every `__ubsan_` handler.
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
export function runtimeHardeningFlags(config, { optimized }) {
  const platform = config.platform;
  const wasi = platform === "wasi";
  const musl = (config.runtimeDefines ?? []).includes("SCR_MUSL");
  return [
    "-ftrivial-auto-var-init=zero",
    "-ftrivial-auto-var-init-max-size=64",
    "-fsanitize=bounds",
    "-fsanitize-trap=bounds",
    ...(wasi ? [] : ["-fstack-protector-strong"]),
    ...(platform === "linux" ? ["-fstack-clash-protection"] : []),
    ...(optimized && !wasi && !musl ? ["-U_FORTIFY_SOURCE", "-D_FORTIFY_SOURCE=2"] : []),
  ];
}
