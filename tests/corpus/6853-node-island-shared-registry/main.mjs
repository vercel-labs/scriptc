// @requires-libnode
// The registry scenario of the Node delegation design (§13): a stateful
// package — a module-level Map, an exported `let counter`, a class — that
// the program and a Node island both import. Island code subclasses the
// package's class, so the package is shared Node-owned (scope-B NI-6): one
// instance, its state visible on both sides, live bindings, `require` and
// `import` answering the same module, instanceof both ways, and an island
// subclass whose override and `super` call cross the boundary.
import fs from "node:fs";
import { requireModule } from "@scriptc/node";
import * as reg from "registry";

const { run } = requireModule("./scenario.mjs");
const log = (s) => fs.writeSync(1, `${s}\n`);
reg.register(new reg.Plugin("owner-a"));
run(log);
log(`owner list: ${reg.list().join(",")}`);
log(`owner counter: ${reg.counter}`);
log(`owner describeAll: ${reg.describeAll()}`);
