// @requires-libnode
// The registry scenario of the Node delegation design (§13) with the
// registry as a program module, shared through the loader hooks over its
// native exports (scope-B NI-6): one instance, its state visible on both
// sides, live bindings, `require` and `import` answering the same module,
// instanceof both ways, and island objects in the native registry. (The
// design's island subclass is in 6843, where the registry is Node-owned.)
import fs from "node:fs";
import { requireModule } from "@scriptc/node";
import * as reg from "./registry.mjs";

const { run } = requireModule("./scenario.mjs");
const log = (s) => fs.writeSync(1, `${s}\n`);
reg.register(new reg.Plugin("owner-a"));
run(log);
log(`owner list: ${reg.list().join(",")}`);
log(`owner counter: ${reg.counter}`);
log(`owner describeAll: ${reg.describeAll()}`);
