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

Repeating `--output` divides the program into that many partitions, which are compiled concurrently and linked together. The helper splits the emitter's LLVM assembly text directly, so partitions also parse concurrently; input outside the emitter's narrow grammar is parsed whole and split with LLVM instead. Internal definitions become hidden so partitions can reference each other. At opt-level 0 each partition is compiled independently. Optimized partitions follow the ThinLTO model: each is simplified and summarized on its own thread, a thin link decides which small functions every partition imports for inlining and which hidden definitions become internal again, and each partition is then optimized and compiled on its own thread. Partition placement depends only on the module and the partition count, so output never depends on the host.

WebAssembly code generation differs from LLVM's default pipeline in two ways that do not change its output. The pass that gives multiple-entry loops a single entry runs only on functions whose control flow is irreducible; its reachability analysis grows with the square of a function's block count even when it has nothing to change. Object emission also leaves out the module pass that collects external symbols for assembly declarations, so each function's machine code is freed once it is printed instead of when the whole module is compiled.

With `--profile-use <file.profdata>`, partitions emitted for ELF targets give each function its own section. Partition placement hashes function names, so the functions that run together are spread over every partition; with one section per function, the linker orders them by the call graph the profile records and places them together.

`--cache-dir <dir>` names a private directory the caller owns for one helper build. Simplified partitions are stored under the hash of their exact source and objects under the hash of the exact module after importing, each with a trailing digest and published by rename, so a rebuild recompiles only the partitions an edit can affect.

`--import-bitcode <unit.bc>`, given once per runtime-pack unit that ships bitcode, imports runtime functions for inlining; scriptc's program builds do not pass it. Small runtime functions reachable from the program's runtime calls are imported as `available_externally` so LLVM can inline them; the runtime objects remain the only definitions. The helper never runs a sanitizer pass, so with import it also drops the emitter's inert `sanitize_address` attributes, which would otherwise block that inlining. Without `--import-bitcode` the module is optimized exactly as emitted.

Runtime-pack builds emit each unit of the executable `speed` flavor through the helper:

```console
scriptc-llvm-codegen runtime-unit --input unit.opt.bc --object unit.o \
  --bitcode unit.bc --target x86_64-unknown-linux-gnu --tag scr_array \
  [--function-sections --data-sections]
```

The input is the runtime compiler's optimized bitcode. The command promotes unit-local symbols to hidden `<name>.scrunit.<tag>` globals and writes the object and the import bitcode from that one module, so imported bodies can reference the unit's private state and helpers.

Release units keep the runtime compiler's own objects. Their import bitcode is the same compilation with `-emit-llvm`, reduced by the helper:

```console
scriptc-llvm-codegen prune-import --input unit.opt.bc --output unit.bc
```

Both commands keep only what a program build can import: the importable bodies within the size limit at their call distance from any public function, and the constants they copy. Every other definition becomes a declaration, so a program imports exactly what it would from the whole unit while reading a fraction of it. Unpromoted unit-local symbols stay local, so release bitcode offers only bodies that need none of them.
