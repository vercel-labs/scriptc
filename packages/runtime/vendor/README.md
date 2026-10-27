# Vendored third-party code

## libucontext (derived source)

- Project: https://github.com/kaniini/libucontext
- Commit: 49e671dd52ff6791295d8161ad3b6da7dc5f6f9d
- License: ISC (copyright and permission notice reproduced in `src/scr_musl.c`)

The x86_64 and AArch64 register-save/restore and `makecontext` logic is adapted into `src/scr_musl.c`, rather than carried as a separate library, to supply the legacy `ucontext` functions that musl declares but does not implement. It is compiled for the explicit `x86_64-linux-musl` and `aarch64-linux-musl` targets and uses musl's public `ucontext_t` layouts. The signal-mask compatibility wrapper is deliberately not included: scriptc fibers perform user-space register swaps and do not change a per-fiber signal mask.

## ryu/

- Project: https://github.com/ulfjack/ryu
- Commit: 4c0618b0e44f7ef027ebae05d2cc7812048f7c8f
- License: Apache-2.0 OR BSL-1.0, used under the Boost Software License 1.0 (see ryu/LICENSE-Boost)

The double-to-shortest-decimal core of Ryū (d2s and its headers only — the float and fixed/exponent variants are not vendored). scr_number.c textually `#include`s d2s.c and calls its internal `d2d` digit generator; ECMA-262 digit *placement* stays in scr_number.c. The only modification to upstream files: `#include "ryu/x.h"` flattened to `#include "x.h"` in d2s.c and d2s_intrinsics.h so the directory is self-contained. To update, re-fetch the listed files at the new commit and re-apply that include flattening.

## v8-ieee754/ (derived source)

- Project: https://github.com/v8/v8, `src/base/ieee754.cc` as Node v24.22.0 bundles it (`deps/v8`, V8 13.6.233.17)
- License: BSD-3-Clause (V8), with fdlibm's notice (see v8-ieee754/LICENSE)

V8's adaptation of fdlibm, the code behind Node's Math.sin, Math.exp, Math.cbrt and the other transcendental functions on every platform. `src/scr_ieee754.c` is a C port of the file, so compiled Math members print the values Node prints. The function bodies are unchanged; the port renames the entry points (`scr_ieee754_*`), gives the kernels internal linkage, and replaces V8's C++ helpers (bit casts, wraparound arithmetic, NaN and infinity constants) with C. `legacy::pow` is not ported: Node's Math.pow calls the platform pow. To update, re-fetch `deps/v8/src/base/ieee754.cc` at the new Node version and repeat the same conversion.

## quickjs-ng/

- Project: https://github.com/quickjs-ng/quickjs
- Version: v0.15.1
- Commit: 3c8f3d68953955950074c41c6e4d999562ae82a7
- License: MIT (see quickjs-ng/LICENSE)

The QuickJS-ng engine is used only by the native compiler's isolated `comptime` evaluator. Compiled user programs never link it. The standalone regex and Unicode libraries from this tree still support native RegExp and string operations.

The tree is a plain snapshot of the upstream commit with directories the library build does not need removed (tests/, docs/, examples/, test262 fixtures, CI config, generator scripts). No vendored file is modified; to update, re-clone upstream at the new commit, delete its .git directory, apply the same trim, and update this file.

The native runtime pack build produces `libscriptc-quickjs.a` for the compiler bootstrap. It is excluded from executable runtime-pack selection.

## zlib/

- Project: https://chromium.googlesource.com/chromium/src/third_party/zlib (Chromium's zlib, a fork of https://github.com/madler/zlib)
- Version: 1.3.2.1-motley-285e94b, the copy Node v24.22.0 bundles in `deps/zlib` (`process.versions.zlib`)
- License: zlib (see zlib/LICENSE)

The codec behind node:zlib's gzip, deflate and inflate functions and streams (see packages/runtime/src/scr_zlib.c) and the native fetch's gzip decoder. The flat `*.c`/`*.h` files at the root of Node's `deps/zlib`, `contrib/optimizations/`, `LICENSE` and `README.chromium` are vendored; `contrib/minizip`, the other contrib directories, tests, patches, Chromium's build files and docs are not. No vendored file is modified, and the files match Node's copy. The gz* file-I/O units are vendored but never compiled (nothing references the gzFile API).

Each target compiles the units and defines Node's `deps/zlib/zlib.gyp` selects for it: the SSSE3 Adler-32 and SSE2 inflate and slide-hash code on x86-64, the NEON code and the ARMv8 CRC-32 code on arm64 Linux, Android and macOS, the NEON inflate and slide-hash code on iOS and Windows arm64, and the portable code (`CPU_NO_SIMD`) elsewhere. The table is `zlibInputs` in packages/runtime-pack-common/scripts/zlib-inputs.mjs (runtime packs) and in packages/compiler/src/backend/vendor-inputs.ts (Zig cross builds and the sanitized runtime), and a unit test keeps the two identical. Android reads CPU features through `getauxval` as Linux does, where Node's Android build uses the NDK's cpu-features library. The SIMD units check the CPU at run time and give the same output as the portable code, so compressed bytes match Node's for the same parameters on every target. To update, copy the same files from the `deps/zlib` of the Node version scriptc follows and bump `ZLIB_VERSION` in vendor-inputs.ts.

Runtime packs archive zlib at `-O3`, as Node builds it. Zig cross builds compile the objects lazily on the first zlib-using cross compile into the per-user build cache's `vendor/zlib-<version>-<flavor>-<target>-<toolchain>/` directory, one flavor per driver/target and compiler environment/identity (the lre-objects pattern). Zlib-free binaries compile and link none of it.

## brotli/

- Project: https://github.com/google/brotli
- Version: 1.2.0 (release tarball brotli-1.2.0.tar.gz, sha256 816c96e8e8f193b40151dad7e8ff37b1221d019dbcb9c35cd3fadbfe6477dfec), the version Node v24.22.0 bundles (`process.versions.brotli`)
- License: MIT (see brotli/LICENSE)

The codec behind node:zlib's Brotli functions and streams (see packages/runtime/src/scr_brotli.c). Only `c/common`, `c/dec`, `c/enc` and `c/include` are vendored, in upstream's layout (LICENSE beside `c/`); the C++ lazy static initializer (`c/enc/static_init_lazy.cc`), the tools, tests, bindings and build machinery are not. No vendored file is modified, and the files match the copy Node bundles in `deps/brotli`. Because the version is Node's, compressed bytes match Node's for the same parameters, so the corpus compares compressed output as well as round trips. To update, re-fetch the release tarball, copy the same directories, and bump `BROTLI_VERSION` in vendor-inputs.ts.

The `dec/` and `enc/` directories share file names (`static_init.c`, `state.h`, `prefix.h`), so archive members are named after their directory (`dec-static_init.o`). Brotli-free binaries compile and link none of it.

## mbedtls/

- Project: https://github.com/Mbed-TLS/mbedtls
- Version: mbedtls-3.6.7 (the 3.6 LTS line — 4.x moved the crypto core into the separate TF-PSA-Crypto repository; the self-contained LTS is what a vendored tree wants)
- License: Apache-2.0 (see mbedtls/LICENSE)

The TLS provider behind node:tls/node:https (see the design note atop packages/runtime/src/scr_tls.c for why mbedTLS over SecureTransport/BoringSSL/libtls). Only `include/` and `library/` are vendored (LICENSE beside them) — tests, docs, programs, scripts, and CMake machinery are not. No vendored file is modified and no custom config is applied (the stock `mbedtls_config.h` builds every `library/*.c` standalone with clang); to update, re-fetch the release tarball, copy the same two directories, and bump `MBEDTLS_VERSION` in packages/compiler/src/backend/vendor-archives.ts.

The archive (libmbedtls.a) is prebuilt best-effort during npm installation (or explicitly by `scriptc cache warm`) and otherwise built lazily on the first TLS-using compile. It lives under the per-user build cache's `vendor/mbedtls-<version>-<flavor>-<target>-<toolchain>/` directory — one flavor per lane (plain, asan), native platform/architecture or explicit cross target, and compiler environment/identity, the libqjs.a pattern. TLS-free binaries never compile or link any of this.

## libsodium/

- Project: https://github.com/jedisct1/libsodium
- Version: 1.0.20 (release tarball libsodium-1.0.20.tar.gz, sha256 ebb65ef6ca439333c2bb41a0c1990587288da07f6c7fd07cb3a18cc18d30ce19)
- License: ISC (see libsodium/LICENSE)

The Ed25519 arithmetic behind node:crypto and WebCrypto Ed25519 keys (see packages/runtime/src/scr_ed25519.c). Its verification matches Node 24: it rejects a non-canonical S and the small-order R and public-key encodings, then checks the cofactorless equation. Only the ref10 Ed25519 subset is vendored, flat in one directory: `crypto_core/ed25519/ref10/ed25519_ref10.c` with its `fe_25_5/` headers, `crypto_sign/ed25519/ref10/{sign,open,keypair}.c` and `sign_ed25519_ref10.h`, `crypto_hash/sha512/cp/hash_sha512_cp.c`, `crypto_verify/verify.c`, and the public and private headers they include. The 64-bit `fe_51` field code (used only with `HAVE_TI_MODE`) and the rest of the library are not vendored.

The only modification to upstream files: `#include "private/x.h"` flattened to `#include "x.h"` in ed25519_ref10.c, sign.c, open.c, keypair.c, hash_sha512_cp.c and ed25519_ref10_fe_25_5.h, so the directory is self-contained. scr_ed25519.c textually includes the .c files and supplies `sodium_memzero`, `sodium_memcmp`, `sodium_is_zero` and `randombytes_buf` (from `arc4random_buf`) in place of libsodium's utils.c and randombytes.c. To update, re-fetch the release tarball, copy the same files, and re-apply that include flattening.

The unit compiles only into programs that use asymmetric keys and name Ed25519 in a string literal (the `ed25519` runtime feature); other binaries never compile or link any of this.
