// The frontend process of an executable build (FrontendProcess and runFrontendProcess in index.ts):
// loads the compiler, then reads the paths of its request and result from stdin. Without them it
// exits: the build found its executable without it.
import { enableCompileCache } from "node:module";

try {
  enableCompileCache();
} catch {
  // Bytecode caching only speeds up loading.
}
const { collectGarbageUnderHeapPressure, runFrontendProcess } = await import("./index.js");
let input = "";
for await (const chunk of process.stdin) input += String(chunk);
const [requestPath, resultPath] = input.split("\n");
if (requestPath !== undefined && requestPath !== "" && resultPath !== undefined) {
  // As in the CLI process, lowering and LLVM emission collect the heap as they grow it.
  collectGarbageUnderHeapPressure();
  await runFrontendProcess(requestPath, resultPath);
}
// The frontend's own helpers (the checker process, timers) must not keep this process alive.
process.exit(0);
