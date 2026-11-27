---
name: scriptc-dev-loop
description: Develop and test a TypeScript or JavaScript program with Node.js while keeping it compilable by scriptc. Use when a project ships an executable or WebAssembly module built with scriptc, or when asked to keep code working under both Node.js and a scriptc build.
metadata:
  internal: true
---

# scriptc development loop

Keep Node.js as the edit, run, and test loop. Use scriptc to check what compiles and to build the binary you ship. Do not build on every edit.

Add `scriptc` and `@scriptc/experimental` to the project's dev dependencies:

```console
$ npm install --save-dev scriptc @scriptc/experimental
$ npm pkg set type=module
```

The second command marks the project as an ES module. A project created with `npm init -y` is CommonJS, and the program and test files in this loop use `import` and top-level `await`, which need module mode.

## Run and test

Run the program and its tests with the load hook and the code-generation flag:

```console
$ NODE_OPTIONS=--disallow-code-generation-from-strings node --import @scriptc/experimental/register app.ts
$ NODE_OPTIONS=--disallow-code-generation-from-strings node --import @scriptc/experimental/register --test
```

The hook refuses the builtin imports and native addons that a build refuses, and reports the compiler's diagnostic codes. Pass both options to every Node.js command in the loop.

## Check after each edit

```console
$ scriptc coverage <entry.ts>
```

Read the blockers, each with a diagnostic code, a location, and a hint. Fix the blocker or change the types so the operation compiles. A program that does not typecheck is not analyzed. Use `--coverage=reached` on a large entry.

## Compare before shipping

```console
$ node --test --test-reporter=@scriptc/experimental/dual-run/reporter --test-reporter-destination=stdout
```

The reporter builds each test file through the executable cache and compares the Node.js and compiled runs. From vitest or jest, call `dualRun(entry)` from `@scriptc/experimental/dual-run` instead. Build the binary once and run it before you push.

## Rules

- Node.js decides behavior. A compiled program must do what Node.js does.
- A coverage blocker is work: fix it, or type the value so the operation compiles.
- Do not add a build step to the edit loop. Run coverage on the changed entry instead.

The full guide is the [Node.js Development Loop](/docs/node-development-loop) page.
