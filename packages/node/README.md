# @scriptc/node

Call into Node.js from a scriptc program. `callSync` and `call` run a function exported by a JavaScript module and copy JSON data both ways. In scriptc builds the function runs in Node.js, which the program loads into its own process on the first call (libnode); under Node.js it runs directly, so the program prints the same either way.

```ts
import { call, callSync } from "@scriptc/node";

const sum = callSync<number>("./math.cjs", "add", 1, 2);
const config = await call<{ regions: string[] }>("config-parser", "parse", source);
```

- The module loads with `require()` from the calling module: relative specifiers resolve from its directory, bare ones from its `node_modules`.
- In scriptc builds the specifier is a string literal. The build collects the module into the executable: a module of the program with the modules its string-literal `require()` and `import` reach, or a whole package with its dependencies. The executable loads them from its own copy, never from the build machine's files. A module of the program that loads others through computed specifiers is refused (SC8006); a module the build cannot find throws `MODULE_NOT_FOUND` when the call runs.
- The executable extracts its modules into `$XDG_CACHE_HOME/scriptc/node-islands/` (or `~/.cache/scriptc/node-islands/`) and checks every file against the build's digests on each start. With `--libnode=beside` they are written next to the executable instead, in `<output>.libnode/modules/`.
- Arguments and results cross as JSON copies; scriptc checks the result against the declared type.
- A thrown `Error` crosses as its nearest intrinsic error class with its `message` and string `code`.
- The executable loads Node from the libnode pack recorded at build time (`SCRIPTC_LIBNODE` or `scriptc build --libnode=<pack directory>`; `--libnode=beside` copies the pack next to the executable). `SCRIPTC_LIBNODE` overrides it at run time. A program that never calls into Node never loads it.
