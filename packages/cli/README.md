# scriptc

Compile TypeScript and JavaScript to native executables or WASI WebAssembly modules that run without Node.js installed.

```console
$ cat fib.ts
function fib(n: number): number {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}
console.log(fib(30));

$ scriptc run fib.ts
832040

$ scriptc build fib.ts -o fib >/dev/null && ./fib
832040
```

scriptc compiles the same TypeScript you run on Node.js, type-checked by the TypeScript compiler. npm packages your program imports compile along with it. Code scriptc can't compile fails the build with an error code and, where available, a rewrite hint.

scriptc is experimental. See the [limitations](https://scriptc.dev/docs/limitations) and the [Node.js compatibility reference](https://scriptc.dev/compatibility).

## Install

```console
$ npm install -g scriptc
```

npm installs the native compiler for your platform (macOS, Linux, or Windows). Node.js 24 or later is needed to install it and to run WASI modules with `scriptc run`; compiling and running executables doesn't need Node.js.

Building executables needs a linker and the platform SDK or sysroot, such as the Xcode Command Line Tools on macOS. Set `SCRIPTC_LINKER` to choose the linker driver. `--emit=ir|llvm|asm|obj` needs no external tools. See the [quickstart](https://scriptc.dev/docs/quickstart) for details.

## Commands

- `scriptc build <file.ts>`: compile to a native executable or another artifact selected with `--emit`.
- `scriptc run <file.ts> [args]`: compile and run, passing the arguments to the program.
- `scriptc coverage <file.ts>`: report what compiles, and explain what doesn't.
- `scriptc build --lib --profile <profile.json>`: compile a static library, or a Wasm reactor on `wasm32-wasi`.
- `scriptc mcp`: serve these commands as tools to an AI agent over the Model Context Protocol.

See the [CLI reference](https://scriptc.dev/docs/cli) for every option.

## Cross-compilation and WebAssembly

Set `SCRIPTC_TARGET` to build for another platform, for example `SCRIPTC_TARGET=aarch64-linux-gnu.2.36` or `SCRIPTC_TARGET=wasm32-wasi`. Install the matching `@scriptc/runtime-<target>` package in your project, at the same version as `scriptc --version`, or set `SCRIPTC_RUNTIME_PACK` to a runtime pack directory. See [platform support](https://scriptc.dev/docs/platforms) and [WebAssembly modules](https://scriptc.dev/docs/wasm).

## Native code

Call C functions by declaring their signatures in TypeScript and binding them to C symbols in a manifest passed with `--ffi <manifest.json>`. See the [Native FFI guide](https://scriptc.dev/docs/ffi).

## Build cache

Builds reuse a bounded persistent cache. Set `SCRIPTC_NO_CACHE=1` to bypass it or `SCRIPTC_CACHE_DIR` to choose its location.

Docs: [scriptc.dev](https://scriptc.dev)
