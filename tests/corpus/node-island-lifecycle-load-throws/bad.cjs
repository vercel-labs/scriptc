"use strict";
console.log("bad.cjs evaluating");
globalThis.__badRuns = (globalThis.__badRuns ?? 0) + 1;
throw new TypeError(`bad module failed (run ${globalThis.__badRuns})`);
