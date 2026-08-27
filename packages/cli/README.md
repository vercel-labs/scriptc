# scriptc

Compile ordinary TypeScript and JavaScript to small, fast native executables or WASI WebAssembly modules — no Node, no V8, no JavaScript engine in the artifact.

```console
$ cat fib.ts
function fib(n: number): number {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}
console.log(fib(30));

$ scriptc run fib.ts
832040

$ scriptc build fib.ts -o fib && ./fib
832040
```

## Install

```console
$ npm install -g scriptc
```

Requires Node.js 24. Executable builds require clang on the PATH (Xcode Command Line Tools on macOS, `clang` package on Linux). `--emit=ir|c|llvm` requires only Node. On macOS 15+ arm64, `--emit=asm|obj` uses the matching optional `@scriptc/llvm-darwin-arm64` helper installed with scriptc and requires no external compiler, archiver, linker, or SDK.

Builds use a bounded persistent cache by default. Exact unchanged library builds validate their recorded TypeScript/module-resolution inputs and restore the generated C/LLVM unit before starting the frontend. TypeScript comment-only edits can restore validated lowered IR instead, rebasing source locations and regenerating exact-source build identity before emission; directives, JSDoc-bearing JavaScript, token edits, configuration, package resolution, and newly appearing candidates still invalidate it. Library identity getters live in a tiny C translation unit, so build-id-only changes reuse the large compiled program object and compile only that small member before rearchiving. The native cache then applies its independent toolchain checks. Unchanged executables and library archives skip native code generation and linking after fresh compiler metadata probes, while edited builds reuse stable runtime objects. Experimental provenance-source builds bypass the early frontend tier because their fetched-source registry is process state. FFI builds with archive/object inputs or ambient `system_libraries` relink every time but still reuse runtime objects. Mutable compiler input paths such as `CPATH` and `SDKROOT`, and compiler wrappers, bypass persistent native artifacts and objects so same-path dependency edits cannot go stale. Opaque archiver wrappers rebuild library program members and archives while retaining runtime-object reuse. Direct Clang, Apple's system Clang shim, `zig cc`, trusted platform archivers, and `zig ar` retain their applicable persistent tiers. Set `SCRIPTC_NO_CACHE=1` to bypass every cache or `SCRIPTC_CACHE_DIR` to choose its location; an existing POSIX override must already be private, otherwise caching is bypassed without changing its permissions.

## Commands

- `scriptc build <file.ts>` — compile to a native executable or selected target artifact
- `scriptc run <file.ts>` — compile and run
- `scriptc coverage <file.ts>` — what compiles statically, and why the rest doesn't

`scriptc build app.ts --emit=ir|c|llvm|asm|obj` selects serialized typed IR,
readable C, textual LLVM IR, target assembly, or a relocatable program object
as the one primary artifact. `--emit=exe` is the default. Assembly/object
emission currently requires a macOS 15+ arm64 host and emits objects targeting
macOS 14.0 (`arm64-apple-macosx14.0.0`).
Objects retain undefined `scr_*` runtime references plus the
`scr_runtime_abi_v1` compatibility marker; they are not library archives.
`--emit=asm|obj --sanitize` is rejected until ASan pipeline parity is
available.

For embedder-hosted modules that are not installed npm packages, coverage can
map an exact bare specifier to a local declaration with repeatable
`--external-types <specifier=file.d.ts>` options. This is analysis-only: the
types unblock application measurement, while runtime module uses remain
reported as blockers.

No annotations, no dialect, no special stdlib: the same TypeScript you run on Node, type-checked by the real TypeScript compiler. Programs outside the static tier can opt into `--dynamic`, which embeds a small JavaScript engine (~620KB) for the parts that can't be static; everything else fails the build with a specific error code and usually a rewrite hint.

WebAssembly is available as a production LLVM target: `SCRIPTC_CC=zigcc SCRIPTC_TARGET=wasm32-wasi scriptc build app.ts`. It emits a WASI Preview 1 `.wasm` module, and `scriptc run` supplies a WASI host. The complete executable language tier—including async, generators, timers, and `--dynamic`—is supported. APIs needing capabilities WASI P1 does not expose (network sockets/fetch, child processes, OS signals, and filesystem watching), sanitizer builds, native FFI, and library-mode archive builds are rejected with `SC3002`.

Native code can be called through an explicit, link-time C ABI manifest: declare the function signature in TypeScript, bind it to a C symbol, and build with `--ffi <manifest.json>`. See the [Native FFI guide](https://scriptc.dev/ffi).

Docs: [scriptc.dev](https://scriptc.dev)
