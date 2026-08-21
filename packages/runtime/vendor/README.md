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

## quickjs-ng/

- Project: https://github.com/quickjs-ng/quickjs
- Version: v0.15.1
- Commit: 3c8f3d68953955950074c41c6e4d999562ae82a7
- License: MIT (see quickjs-ng/LICENSE)

The QuickJS-ng JavaScript engine, embedded by the opt-in `--dynamic` build mode (see packages/runtime/src/scr_island.c). Static builds never compile or link any of this.

The tree is a plain snapshot of the upstream commit with directories the library build does not need removed (tests/, docs/, examples/, test262 fixtures, CI config, generator scripts). No vendored file is modified; to update, re-clone upstream at the new commit, delete its .git directory, apply the same trim, and update this file.

The engine archive (libqjs.a) is prebuilt best-effort during npm installation (or explicitly by `scriptc cache warm`) and otherwise built lazily on the first `--dynamic` compile. It lives under the per-user build cache's `vendor/<commit>-<flavor>-<target>-<toolchain>/` directory — one flavor per lane (plain, asan), native platform/architecture or explicit cross target, and compiler environment/identity.

## zlib/

- Project: https://github.com/madler/zlib
- Version: 1.3.1 (release tarball zlib-1.3.1.tar.gz, sha256 9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23)
- License: zlib (see zlib/LICENSE)

The CROSS-target arm of node:zlib (see packages/runtime/src/scr_zlib.c): host builds keep the historical system `-lz` link (macOS ships libz), but zig's cross sysroots have no libz, so SCRIPTC_TARGET builds compile this vendored copy per target instead. Only the flat `*.c`/`*.h` at the distribution root are vendored (LICENSE beside them) — contrib, tests, build machinery, and docs are not. No vendored file is modified; the gz* file-I/O TUs are vendored for faithfulness but never compiled (nothing references the gzFile API — see ZLIB_SOURCES in packages/compiler/src/backend/cc.ts). To update, re-fetch the release tarball, copy the same flat set, and bump `ZLIB_VERSION` in cc.ts.

The objects build lazily on the first zlib-using cross compile into the per-user build cache's `vendor/zlib-<version>-<flavor>-<target>-<toolchain>/` directory — one flavor per driver/target and compiler environment/identity (the lre-objects pattern). Zlib-free binaries never compile any of this; compressed OUTPUT bytes are zlib-version-dependent, which is why the corpus only compares round-trips and fixed-blob inflation.

## curl/

- Project: https://curl.se/ (Debian bookworm's libcurl4-openssl-dev 7.88.1, the exact library the Linux lane's pinned container image ships)
- Version: 7.88.1 (headers copied byte-for-byte from `node:24.15.0-bookworm`'s `/usr/include/aarch64-linux-gnu/curl/`; the arch-specific include dir is Debian multiarch layout — the headers themselves are architecture-independent, `system.h` selects per-arch typedefs at preprocessing time)
- License: curl (see curl/COPYRIGHT — the Debian machine-readable copyright file for the package the headers came from)

HEADERS ONLY — no curl C source is vendored and none is ever compiled. These headers now serve ONLY the RETIRED curl reference implementation of fetch (packages/runtime/src/scr_fetch_curl.c, selected by `SCRIPTC_FETCH_CURL=1`; kept compilable for one release as the native flip's reference — see scr_fetch.c, the default, which rides scr_net/scr_tls/scr_http/zlib and touches nothing here). Under the flag: host builds link the system `-lcurl` (macOS ships libcurl), and linux-gnu CROSS builds compile scr_fetch_curl.c against these headers, then link against a generated STUB `libcurl.so` (soname `libcurl.so.4`, empty definitions of exactly the symbols scr_fetch_curl.c calls — see CURL_STUB_SYMBOLS in packages/compiler/src/backend/cc.ts) so the produced binary records a plain `DT_NEEDED libcurl.so.4` that the TARGET system's real libcurl satisfies at load time, the standard cross-link import-stub technique. The 7.88.1 pin is a floor, not a lock: scr_fetch_curl.c's newest requirement is CURLOPT_PROTOCOLS_STR (7.85.0) and the unversioned symbol references bind to any libcurl.so.4. This whole directory leaves with scr_fetch_curl.c when the reference retires for good.

The stub builds lazily on the first flag-selected fetch cross compile into the per-user build cache's `vendor/curl-stub-<target>-<toolchain>/` directory (the zlib-objects pattern). Default builds never see any of this, and no build ever compiles curl itself.

## mbedtls/

- Project: https://github.com/Mbed-TLS/mbedtls
- Version: mbedtls-3.6.7 (the 3.6 LTS line — 4.x moved the crypto core into the separate TF-PSA-Crypto repository; the self-contained LTS is what a vendored tree wants)
- License: Apache-2.0 (see mbedtls/LICENSE)

The TLS provider behind node:tls/node:https (see the design note atop packages/runtime/src/scr_tls.c for why mbedTLS over SecureTransport/BoringSSL/libtls). Only `include/` and `library/` are vendored (LICENSE beside them) — tests, docs, programs, scripts, and CMake machinery are not. No vendored file is modified and no custom config is applied (the stock `mbedtls_config.h` builds every `library/*.c` standalone with clang); to update, re-fetch the release tarball, copy the same two directories, and bump `MBEDTLS_VERSION` in packages/compiler/src/backend/cc.ts.

The archive (libmbedtls.a) is prebuilt best-effort during npm installation (or explicitly by `scriptc cache warm`) and otherwise built lazily on the first TLS-using compile. It lives under the per-user build cache's `vendor/mbedtls-<version>-<flavor>-<target>-<toolchain>/` directory — one flavor per lane (plain, asan), native platform/architecture or explicit cross target, and compiler environment/identity, the libqjs.a pattern. TLS-free binaries never compile or link any of this.
