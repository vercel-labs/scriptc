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

- Project: https://github.com/v8/v8, `src/base/ieee754.cc` as Node v24.22.1 bundles it (`deps/v8`, V8 13.6.233.17)
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
- Version: 1.3.2.1-motley-285e94b, the copy Node v24.22.1 bundles in `deps/zlib` (`process.versions.zlib`)
- License: zlib (see zlib/LICENSE)

The codec behind node:zlib's gzip, deflate and inflate functions and streams (see packages/runtime/src/scr_zlib.c) and the native fetch's gzip decoder. The flat `*.c`/`*.h` files at the root of Node's `deps/zlib`, `contrib/optimizations/`, `LICENSE` and `README.chromium` are vendored; `contrib/minizip`, the other contrib directories, tests, patches, Chromium's build files and docs are not. No vendored file is modified, and the files match Node's copy. The gz* file-I/O units are vendored but never compiled (nothing references the gzFile API).

Each target compiles the units and defines Node's `deps/zlib/zlib.gyp` selects for it: the SSSE3 Adler-32 and SSE2 inflate and slide-hash code on x86-64, the NEON code and the ARMv8 CRC-32 code on arm64 Linux, Android and macOS, the NEON inflate and slide-hash code on iOS and Windows arm64, and the portable code (`CPU_NO_SIMD`) elsewhere. The table is `zlibInputs` in packages/runtime-pack-common/scripts/zlib-inputs.mjs (runtime packs) and in packages/compiler/src/backend/vendor-inputs.ts (Zig cross builds and the sanitized runtime), and a unit test keeps the two identical. Android reads CPU features through `getauxval` as Linux does, where Node's Android build uses the NDK's cpu-features library. The SIMD units check the CPU at run time and give the same output as the portable code, so compressed bytes match Node's for the same parameters on every target. To update, copy the same files from the `deps/zlib` of the Node version scriptc follows and bump `ZLIB_VERSION` in vendor-inputs.ts.

Runtime packs archive zlib at `-O3`, as Node builds it. Zig cross builds compile the objects lazily on the first zlib-using cross compile into the per-user build cache's `vendor/zlib-<version>-<flavor>-<target>-<toolchain>/` directory, one flavor per driver/target and compiler environment/identity (the lre-objects pattern). Zlib-free binaries compile and link none of it.

## brotli/

- Project: https://github.com/google/brotli
- Version: 1.2.0 (release tarball brotli-1.2.0.tar.gz, sha256 816c96e8e8f193b40151dad7e8ff37b1221d019dbcb9c35cd3fadbfe6477dfec), the version Node v24.22.1 bundles (`process.versions.brotli`)
- License: MIT (see brotli/LICENSE)

The codec behind node:zlib's Brotli functions and streams (see packages/runtime/src/scr_brotli.c). Only `c/common`, `c/dec`, `c/enc` and `c/include` are vendored, in upstream's layout (LICENSE beside `c/`); the C++ lazy static initializer (`c/enc/static_init_lazy.cc`), the tools, tests, bindings and build machinery are not. No vendored file is modified, and the files match the copy Node bundles in `deps/brotli`, which is the 1.2.0 release plus upstream commit `0ed4268a` ("Detect and report invalid stream earlier"): `c/dec/decode.c` and `c/include/brotli/decode.h` carry it, so a block switch that names a type the metablock header never declared is rejected with `BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH` instead of decoding on in the malformed state (CVE-2026-111497, the Node 24.22.1 fix). Because the version is Node's, compressed bytes match Node's for the same parameters, so the corpus compares compressed output as well as round trips. To update, re-fetch the release tarball, copy the same directories, take those two files from Node's `deps/brotli` (or apply `0ed4268a`) when the release predates the fix, and bump `BROTLI_VERSION` in vendor-inputs.ts.

The `dec/` and `enc/` directories share file names (`static_init.c`, `state.h`, `prefix.h`), so archive members are named after their directory (`dec-static_init.o`). Brotli-free binaries compile and link none of it.

## zstd/

- Project: https://github.com/facebook/zstd
- Version: 1.5.7, the release Node v24.22.1 bundles in `deps/zstd`
- License: BSD-3-Clause (see zstd/LICENSE)

The codec behind node:zlib's zstd functions and streams (see packages/runtime/src/scr_zstd.c). Node's `deps/zstd` carries the upstream release as its `lib/` directory beside the gyp files; `lib/common`, `lib/compress`, `lib/decompress`, `lib/zstd.h`, `lib/zstd_errors.h` and `LICENSE` are vendored in that layout. The dictionary builder, the legacy decoder, the assembly decoder, the programs, tests and build machinery are not, and no vendored file is modified. Because the version is Node's and it compiles the same units with the same defines, compressed frames match Node's for the same parameters.

Each build compiles the units and defines Node's `deps/zstd/zstd.gyp` selects: every `.c` file under those three directories, with `XXH_NAMESPACE=ZSTD_`, `ZSTD_DISABLE_ASM`, and `ZSTD_MULTITHREAD` wherever the target has threads (WASI does not, so its build compresses on one thread). The table is `zstdInputs` in packages/runtime-pack-common/scripts/zstd-inputs.mjs (runtime packs) and in packages/compiler/src/backend/vendor-inputs.ts (Zig cross builds and the sanitized runtime), and a unit test keeps the two identical. To update, copy the same files from the `deps/zstd` of the Node version scriptc follows and bump `ZSTD_VERSION` in vendor-inputs.ts.

Runtime packs archive zstd at `-O3`. Zig cross builds compile the objects lazily on the first zstd-using cross compile into the per-user build cache's `vendor/zstd-<version>-<flavor>-<target>-<toolchain>/` directory, the zlib-objects pattern. Zstd-free binaries compile and link none of it.

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

## ICU (fetched, not vendored)

- Project: https://github.com/unicode-org/icu
- Version: ICU4C 78.3, from the `release-78.3` tag — the exact release Node v24.22.1 bundles (`process.versions.icu`)
- License: Unicode License V3; the sources and the data file ship under the same terms

The locale/CLDR engine behind the Intl forms only it can answer (see packages/runtime/src/scr_intl.c): the default locale's number and date formats, and word-granularity segmentation. Engine-free Intl forms do not use it and stay in scr_grapheme.c and scr_lib.c.

ICU is not vendored: 970 source files plus 33 MiB of compiled CLDR tables are a download, not a reviewable tree in this repository. Both build inputs come from unicode-org/icu's official GitHub release for the pinned version, and both are pinned by version and sha256 in packages/compiler/src/backend/vendor-inputs.ts (mirrored in packages/runtime-pack-common/scripts/icu-inputs.mjs for the runtime packs, with a unit test that keeps the two identical):

- `icu4c-78.3-sources.tgz` (27,977,255 B, sha256 `3a2e7a47604ba702f345878308e6fefeca612ee895cf4a5f222e7955fabfe0c0`), the release's own source tarball: `common/`, `i18n/` and `stubdata/` (the empty data-symbol stub ICU needs when its data ships outside the archive), plus LICENSE. `source/common/sources.txt` and `source/i18n/sources.txt` are the *lists of record*: a build compiles exactly the units ICU's own autoconf build compiles, so `icuSourceList` (vendor-inputs.ts for the source-build path, packages/runtime-pack-common/scripts/icu-data.mjs for the runtime packs) reads them rather than re-deriving the set.
- `icu4c-78.3-data-bin-l.zip` (12,836,659 B, sha256 `982619632b78887f1895b063e96e8c3cc7f99283337c8abbd05aa71635de613c`), whose `icudt78l.dat` (33,107,232 B, sha256 `d5cf2a40dccbe471781ec7af85693bff542ff12f0b670c9630c4e72d60714b8b`) is not compiled. The pack build writes a copy without the data categories no Intl form reads, ships it as `artifacts/icu/icudt78l.dat` and installs it beside every executable that links ICU, where the runtime looks first (`$ORIGIN`-style: the executable's own directory), then `ICU_DATA`.

The pack's copy of `icudt78l.dat` (11,653,984 B, sha256 `513a72821c8ee68c7e8a24c346cadc2f8de22efaa19fb68c14957f313e74f35b`) leaves out the items `ICU_DATA_DROPPED` in icu-inputs.mjs names: the charset converters (`*.cnv`) and the `coll/`, `lang/`, `rbnf/`, `region/`, `translit/`, `unit/` and `zone/` trees, 21.5 MB that scr_intl.c's break iterators, number and date formatters, calendars and locale IDs never read. `filterIcuData` in icu-data.mjs rewrites the data file's table of contents to the remaining items, and the build checks the result against the pinned sha256 and size. tests/harness/icu-data-filter.test.ts runs every `@requires-icu` corpus program under 47 locales and 3 time zones with the pack's data, with the full data and in Node, and fails when the outputs differ. An Intl form that reads a dropped category (time zone names, display names, collation, unit names) removes it from `ICU_DATA_DROPPED` and updates the two pins in the same change.

Each download is cached (the runtime-pack build under `node_modules/.cache/scriptc-icu-*`, the source-build path under the per-user build cache's `vendor/`), verified against its pinned sha256 on every use, and unpacked by the small zip reader in icu-data.mjs (the data) or the system `tar` (the sources). A hash mismatch fails the build with both hashes; an offline build works from a pre-populated cache. To update, bump `ICU_VERSION` with the new release's two assets' sizes and sha256 in vendor-inputs.ts and icu-inputs.mjs.

Three build properties are worth knowing:

- **The TUs compile with `zig c++ -target x86_64-linux-gnu.2.34`, not with the host `clang++`.** The host C++ toolchain cannot honor the runtime packs' glibc floor: from glibc 2.38 the C++ feature test macros turn on `__GLIBC_USE_C23_STRTOL`, which renames `strtol`/`strtoul` to `__isoc23_*` (features.h `#undef`s any predefinition), the host `libstdc++` binds those names too, and the pack artifact policy rejects them. Zig's C++ driver compiles for the target's glibc and takes its standard library from the toolchain's own sources, so no object binds a name above the floor. The cost is that an Intl build needs Zig 0.16.0 (its `<lib_dir>` answers `zig env`; `ZIG_LIB_DIR` overrides), and that only linux-x64-gnu carries ICU in this slice — the source-build path refuses an explicit cross target.
- **ICU requires RTTI.** `unifiedcache.h` and `ustrenum.cpp` use `typeid` and `uniset_props.cpp` uses `dynamic_cast`, so the design note's `-fno-rtti` is not available. `-fno-exceptions` is, and ICU is written to build without exceptions; it is used.
- **The C++ standard library is compiled from Zig's bundled sources and merged into the archive.** The `libcxx/src` and `libcxxabi/src` units (all but `cxa_personality.cpp`, the one unit that needs exceptions) compile beside ICU's and are archived with them under `cxx-libcxx-`/`cxx-libcxxabi-` members, so the final link stays a plain C link that the pack's `-lm` satisfies. Symbol renaming stays ON (ICU's `_78` suffixes), which is what lets the zero-cost gate (`icuSymbols()` in scripts/zero-cost-compare.mjs) prove that a binary which does not use Intl links no ICU symbol at all.

The runtime-pack archive is `artifacts/vendor/icu/libscriptc-icu.a`; the source-build path builds the same archive lazily on the first Intl compile into the per-user build cache's `vendor/icu-78.3-<flavor>-<target>-<toolchain>/` directory (ensureIcuArchive in packages/compiler/src/backend/vendor-archives.ts). Intl-free binaries compile and link none of it.

Beside the archive, the pack ships the ICU headers scr_intl.c includes in `artifacts/vendor/icu/include/unicode/`, listed with their sizes and sha256 in the manifest's `headers`. The pack build selects them from the compiler's `-MM` scan of scr_intl.c. A sanitized build in the native compiler compiles scr_intl.c from this package's sources, which carry no ICU headers, so it adds that directory to the include path and refuses with SC3003 when the pack lists no headers or a header does not match its hash.
