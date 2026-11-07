# scriptc

<p>
  <a href="https://vercel.com/labs#active-experiments"><img alt="Vercel Labs Experiment" src="https://img.shields.io/badge/LABS-EXPERIMENT-0a0a0a.svg?style=for-the-badge&amp;logo=Vercel&amp;labelColor=000000" height="28"></a>
  <a href="https://www.npmjs.com/package/scriptc"><img alt="npm version: scriptc" src="https://img.shields.io/npm/v/scriptc.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
  <a href="https://github.com/vercel-labs/scriptc/blob/main/LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/github/license/vercel-labs/scriptc.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
  <a href="https://www.npmjs.com/package/scriptc"><img alt="npm downloads per month: scriptc" src="https://img.shields.io/npm/dm/scriptc.svg?style=for-the-badge&amp;labelColor=000000&amp;label=npm%20downloads" height="28"></a>
</p>

scriptc compiles TypeScript and JavaScript to native executables and WebAssembly. It uses the types checked by the TypeScript compiler to generate machine code, and a program that compiles entirely to native code runs without Node.js installed. npm packages your program imports compile along with it; a package that can't compile natively runs in a [Node island](https://scriptc.dev/docs/node-islands), inside Node.js that the executable loads on first use. Code of your own that scriptc can't compile is reported at build time with a diagnostic and, where available, a rewrite hint.

scriptc is experimental and supports a subset of JavaScript, TypeScript, and Node.js APIs. Run `scriptc coverage` on an existing program to see how much of it compiles, and see the [limitations](https://scriptc.dev/docs/limitations) and [Node.js compatibility reference](https://scriptc.dev/compatibility) for details.

## Installation

Install with Node.js 24 or later and npm:

```console
$ npm install -g scriptc
```

The installed compiler runs natively on macOS, Linux, and Windows. Node.js is needed only to install it and to run WASI modules with `scriptc run`. Standalone compiler archives are also available from [GitHub Releases](https://github.com/vercel-labs/scriptc/releases).

Building executables requires a linker and the platform SDK or sysroot. See the [quickstart](https://scriptc.dev/docs/quickstart) for prerequisites and [platform support](https://scriptc.dev/docs/platforms) for host requirements, cross-compilation, and WebAssembly.

## Build a program

Create `hello.ts`:

```ts
const who = process.argv.length > 2 ? process.argv[2] : "world";
console.log(`hello, ${who}`);
```

`scriptc run` compiles the file and runs the result:

```console
$ scriptc run hello.ts
hello, world
```

`scriptc build` writes an executable:

```console
$ scriptc build hello.ts -o hello >/dev/null
$ ./hello scriptc
hello, scriptc
```

These examples use POSIX shell syntax. On Windows, build `hello.exe` and run it with `.\hello.exe`.

Use `scriptc coverage hello.ts` to check what compiles before you build. See [coverage reports](https://scriptc.dev/docs/coverage) for details.

## Use Node APIs

Supported Node APIs compile to the native runtime. For example, `server.ts`:

```ts
import { createServer } from "node:http";

const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ path: req.url }));
});

server.listen(8080, () => {
  console.log("listening on http://localhost:8080");
});
```

```console
$ scriptc build server.ts -o server >/dev/null
$ ./server
listening on http://localhost:8080
```

## Use npm packages

npm packages compile into the executable with your code, so it doesn't read `node_modules` at runtime.

Create `cli.ts`:

```ts
import pc from "picocolors";

console.log(pc.green("hello from scriptc"));
```

```console
$ npm install picocolors
$ scriptc build cli.ts -o cli >/dev/null
$ ./cli
hello from scriptc
```

Package support is partial. See [npm dependencies](https://scriptc.dev/docs/dependencies) for which packages compile and how to check them.

## Documentation

- [Introduction](https://scriptc.dev/docs): what scriptc is and what you can build.
- [Quickstart](https://scriptc.dev/docs/quickstart): installation and your first executable.
- [Coverage reports](https://scriptc.dev/docs/coverage): check whether an existing program compiles.
- [Platform support](https://scriptc.dev/docs/platforms): cross-compilation and WebAssembly.
- [CLI reference](https://scriptc.dev/docs/cli): commands, options, and output formats.
- [Native program objects](https://scriptc.dev/docs/native-objects): use compiler output in external builds.
- [Native FFI](https://scriptc.dev/docs/ffi): call C ABI functions from compiled programs.
- [WebAssembly modules](https://scriptc.dev/docs/wasm): build and embed WASI modules.
- [Examples](./examples): programs and integration examples in this repository.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for source setup, testing, native artifact builds, and docs development.
