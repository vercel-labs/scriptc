# Static scriptc and Test262

This runner compiles Test262 programs with `dynamic: false` and scriptc's default backend selection, then executes native binaries in separate processes. `upstream.json` pins the Test262 revision, archive checksum, complete snapshot digest, and unmodified vendored regression inputs. Test262's BSD license is retained in `vendor/LICENSE`.

Run the offline regression profile from the repository root:

```bash
pnpm test:test262
```

The vendored inputs are regression fixtures for developing the runner and compiler. Strict variants are checked against `expectations.json`; entries without an expectation require successful completion. Sloppy variants remain visible as exclusions. A recorded refusal remains a refusal, and a different outcome fails the regression gate. An external snapshot survey treats every executed non-pass as a failing exit status. An all-excluded selection also fails, except for empty distributed shards.

The same regression tests and host assertion checks are included in `pnpm test`. `pnpm test:sandbox` partitions the cases across both plain and sanitized lanes. The default backend may fall back from LLVM to C according to the ordinary compiler policy; every executed result records the actual backend. `--backend llvm` or `--backend c` pins a backend, and `SCRIPTC_SAN=1` enables sanitizers.

## Full snapshot surveys

Download and verify the complete pinned snapshot:

```bash
pnpm test:test262:fetch
```

Pass the resulting directory as `--root` and use `--filter` to survey an API family. `--root` also accepts a checkout or extracted archive whose contents match the pinned snapshot. The runner verifies all test, fixture, and upstream harness bytes before selection. `--list` inventories variants and exclusion reasons without compiling. `--limit` selects the first N matching files; `--workers` controls concurrent compiles and otherwise follows `SCRIPTC_TEST_WORKERS`, defaulting to two. `SCRIPTC_TEST_SHARD=i/n` partitions variants using the existing stable case sharder.

`--report` selects a JSON report path; the default is `node_modules/.cache/scriptc-test262/report.json`. `--journal` writes each completed result to a new JSONL file during execution, preserving evidence if a long survey is interrupted; it refuses to overwrite an existing file. Reports retain the upstream revision, profile, adapter hash, compiler package version, backend, sanitizer setting, host, selection counts, feature metadata, exclusions, and per-variant outcomes. Pass counts describe the selected adapted profile and must not be presented as whole-suite ECMAScript conformance. Compiler refusals, runtime refusals, harness refusals, assertion failures, build errors, crashes, and timeouts are separate outcomes. Exclusions are runner capabilities, not scriptc implementation classifications.

`--compile-timeout` and `--runtime-timeout` bound each compiler and native process in milliseconds. The defaults are 120 seconds and 10 seconds. Standard input is closed, output is bounded, and a completion marker prevents an early successful exit from counting as a pass. `--keep` retains generated sources, compile diagnostics, and binaries for investigation; ordinary runs remove temporary artifacts. Sanitizer diagnostics cannot satisfy a known-refusal expectation.

## Execution profile and limits

The current profile is `static-strict-scalar-adapter-v1`. It selects synchronous, positive strict-script variants and adapts each script to a standalone module. Preparation adds a strict directive, imports the host assertions, appends a completion marker, and leaves the upstream test body unchanged. Each program executes in a fresh native process. Conservative syntax checks reject known global-script dependencies, but do not establish that every module adaptation preserves the original script's semantics. Reports are local investigation artifacts, not published compatibility assessments.

The unmodified upstream assertion helper currently reaches scriptc's JavaScript function-expando refusal. Test262 explicitly permits host implementations of harness functions in its [interpretation rules](https://github.com/tc39/test262/blob/7ab7fafa0003f73fc85c1b95d88094d33f7eb8bd/INTERPRETING.md#host-defined-functions). `harness.ts` supplies `assert`, `assert.sameValue`, `assert.notSameValue`, `assert.compareArray`, and `Test262Error`. Scalar SameValue and scalar array-element comparisons use the statically compiled `node:assert/strict` implementation. Contract tests compare successful and failing assertions with the original Test262 helpers under Node, including NaN, signed zero, null/undefined, differing primitive types, and premature termination.

Reference-equality assertions terminate with a distinct harness-refusal result: conversion at a native function boundary can copy references, so this adapter cannot faithfully compare every object, array, or function identity. Tests cannot catch this refusal and accidentally pass. Sparse array comparisons are not yet handled faithfully across that boundary. Assertion aliases, mutation, reflection, additional assertion methods, and `includes` helpers other than `compareArray.js` remain excluded.

Sloppy variants, raw tests, modules, asynchronous completion, agents, and negative tests are currently excluded. Parse, resolution, and runtime negative phases retain their distinct reasons; arbitrary compiler errors never satisfy a negative expectation. `$262`, dynamic evaluation, observable script-global state, and other unsupported host requirements are excluded as well. The runtime and compiler continue to enforce their existing refusal boundaries for admitted source.

To expand the regression profile, review the original test's execution requirements, copy its source and license unchanged from the pinned snapshot, add its path and SHA-256 to `upstream.json`, and execute it under the upstream Node harness and static scriptc. Preserve meaningful failures with narrowly documented expectations. Extend the host adapter only with controls that demonstrate both successful and deliberately failing assertions; then run the focused harness and the full sandbox gate.
