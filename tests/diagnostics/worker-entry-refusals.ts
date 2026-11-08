// A Worker's entry must be a module path the compiler can resolve to a
// compiled source file of this program. Each refusal names the shape it
// saw, so a program can tell a runtime specifier from a relative path from
// a path that resolves to no compilable worker.
import { Worker } from "node:worker_threads";

// The specifier is only known at run time: no compiled entry to start.
function start(specifier: string | URL): Worker {
  return new Worker(specifier);
}
console.log(typeof start);

// A static path Node would resolve against the invocation's working
// directory: no build-time graph.
const relative = new Worker("./entry.ts");
console.log(typeof relative);

// A source-relative URL that resolves to a declaration file: a real path,
// but nothing a worker can compile.
const declaration = new Worker(new URL("./worker-entry-refusals/decl.d.ts", import.meta.url));
console.log(typeof declaration);
