# Vendored: mlkem-native

- Source: https://github.com/pq-code-package/mlkem-native
- Tag: v2.0.0 (released 2026-08-07)
- Tarball: https://codeload.github.com/pq-code-package/mlkem-native/tar.gz/refs/tags/v2.0.0
- Vendored directory: the upstream `mlkem/` library tree, plus the upstream
  repository `LICENSE` file (kept verbatim at ./LICENSE).
- License: Apache-2.0 OR ISC OR MIT (upstream's choice); this project uses it
  under **Apache-2.0**, matching the other vendored crates in this directory.
- Local changes: none. The runtime compiles `mlkem_native.c` (C backend only)
  three times, one per parameter set, with
  `-DMLK_CONFIG_MULTILEVEL_BUILD` and the matching
  `MLK_CONFIG_MULTILEVEL_WITH_SHARED`/`MLK_CONFIG_MULTILEVEL_NO_SHARED`.
