// Patching a NATIVE host object: Node lets a library swap
// `process.stdout.write`, hand out `process.stdout.write.bind(...)`, or
// redefine a module member with Object.defineProperty. The process output
// stream's write slot is the runtime stream object's, so the assignment and
// the bind compile. A builtin module's exports are direct calls, so those
// forms keep an explicit refusal instead of silently patching nothing. The
// working split: use the module's functions directly.

import * as fs from "node:fs";

export function bindReadFileSync(): typeof fs.readFileSync {
  return fs.readFileSync.bind(fs);
}

export function defineReadFileSync(): void {
  Object.defineProperty(fs, "readFileSync", { value: () => "" });
}

bindReadFileSync();
defineReadFileSync();
