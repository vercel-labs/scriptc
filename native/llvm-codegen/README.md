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

Repeating `--output` divides the program into that many partitions, which are compiled concurrently and linked together. The helper splits the emitter's LLVM assembly text directly, so partitions also parse concurrently; input outside the emitter's narrow grammar is parsed whole and split with LLVM instead. Internal definitions that no other definition reaches are left out of every partition, and the others become hidden so partitions can reference each other. At opt-level 0 each partition is compiled independently. Optimized partitions follow the ThinLTO model: each is simplified and summarized on its own thread, a thin link decides which small functions every partition imports for inlining and which hidden definitions become internal again, and each partition is then optimized and compiled on its own thread. Partition placement depends only on the module and the partition count, so output never depends on the host.

With `--split codegen`, several outputs divide only code generation. The helper optimizes the module whole, as it does for a single output, then divides its functions in module order into runs of about the same instruction count, one per output, and generates code for every output on its own thread. Linking the outputs in order lays the functions out as one output would. A local definition that another output uses becomes hidden so the objects can reference each other; the others stay local. Every output after the first is generated from a copy of the optimized module read back from bitcode with its use-list order, so each function's machine code matches a single output except for jumps to definitions that another output also uses. When one run would hold more than three quarters of the module's instructions, the first output holds the whole module and the other outputs are empty objects. Placement depends only on the optimized module and the output count. `--split codegen` requires an optimized build and no `--cache-dir`; scriptc passes it for optimized executables with more than 128 KiB of LLVM text that stay one partition.

WebAssembly code generation differs from LLVM's default pipeline in two ways that do not change its output. The pass that gives multiple-entry loops a single entry runs only on functions whose control flow is irreducible; its reachability analysis grows with the square of a function's block count even when it has nothing to change. Object emission also leaves out the module pass that collects external symbols for assembly declarations, so each function's machine code is freed once it is printed instead of when the whole module is compiled.

`--cache-dir <dir>` names a private directory the caller owns for one helper build. Simplified partitions are stored under the hash of their exact source and objects under the hash of the exact module after importing, each with a trailing digest and published by rename, so a rebuild recompiles only the partitions an edit can affect. Partitions drop the names of their struct types before the thin link, which would otherwise number same-named types from different partitions in an order that any edit can shift, changing the module after importing in partitions the edit did not touch.

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

## Linux release builds

The Linux helper packages are released linked against LLVM 22.1.8 built from its release sources with ThinLTO and with `llvm.profdata.gz`, a profile of the helper's own code generation (`llvm-dist.mjs`). The helper's code generation is 5-9% faster with it than when the helper links LLVM's release archive, and its objects are identical. The release workflow downloads that build from the `LLVM_DIST_TAG` release of this repository; when the archive is missing, the helper links LLVM's release archive instead.

To build and use it locally, with clang, lld and llvm-profdata 22.1.8 on `PATH` (LLVM's release archive for the host has them):

```console
$ node scripts/build-llvm-dist.mjs --source llvm-project-22.1.8.src --prefix <dir>
$ LLVM_DIR=<dir>/lib/cmake/llvm SCRIPTC_LLVM_THINLTO=1 pnpm --filter @scriptc/llvm-linux-x64-gnu build:native
```

`SCRIPTC_LLVM_THINLTO=1` compiles and links the helper with clang, lld and ThinLTO, since that LLVM's archives hold bitcode, and optimizes the helper's own sources with the same profile. The link takes about 4 minutes on 4 cores.

The `llvm-dist` workflow (run by hand) builds the archive for x64 and arm64, checks that a helper linked against it gives the same objects as one linked against LLVM's release archive (`scripts/check-llvm-dist.mjs`), and attaches it to the release. The arm64 build uses the profile collected on x64, and its log reports how many functions the profile does not match there.

The profile depends on LLVM's sources and the kind of code scriptc emits, not on scriptc's commits. `scripts/refresh-llvm-profile.mjs` collects a new one after an LLVM version change: it builds LLVM with IR instrumentation and an instrumented helper, runs that helper on tsc-ts, five Effect fixtures, the runtime benchmark workloads and every 50th corpus program (`scripts/llvm-helper-inputs.mjs`), and merges the result. A new profile or LLVM version gets a new `LLVM_DIST_TAG`.
