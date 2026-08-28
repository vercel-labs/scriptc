# scriptc LLVM code-generation helper

This out-of-process helper owns LLVM assembly and object emission for
scriptc. It is built against exactly LLVM 22.1.8 and currently contains only
the AArch64 backend. The shipping `@scriptc/llvm-darwin-arm64` package builds
and carries the executable; the compiler resolves that package directly and
never searches `PATH` for this program.

The ordinary workspace `pnpm -r build` does not rebuild this release artifact.
On macOS arm64, install CMake, Ninja, and Homebrew `llvm@22`, then build it
explicitly when working on native emission or preparing a package:

```console
$ brew install cmake ninja llvm@22
$ pnpm --filter @scriptc/llvm-darwin-arm64 build:native
```

The protocol is intentionally small and versioned:

The packaged helper itself requires macOS 15 or newer because that is the
minimum version of the pinned LLVM bottle it statically links. Its emitted
assembly and objects separately target macOS 14 via the triple below.

```console
scriptc-llvm-codegen version --format=json
scriptc-llvm-codegen emit --input app.ll --output app.o --filetype obj \
  --target arm64-apple-macosx14.0.0 --opt-level 2 \
  --relocation-model pic --diagnostic-format json --source-path app.ts
```

Emission uses LLVM 22's default per-module O2 pipeline, including coroutine
lowering, verifies before and after optimization, and publishes through a
private sibling file so a failed or interrupted request cannot truncate the
requested output.
