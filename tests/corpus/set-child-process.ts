// A Set of live ChildProcess handles: pointer identity is JS identity, so a
// duplicate add collapses, has/delete answer by identity, and iteration plus
// spread read the members. The children release after their exit events.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

const children = new Set<ChildProcess>();
const first = spawn("true");
const second = spawn("true");
children.add(first);
children.add(first);
children.add(second);
console.log("size:", children.size, children.has(first), children.has(second));

await Promise.all(
  [...children].map((child) => new Promise<void>((resolve) => child.on("exit", () => resolve())))
);
children.delete(first);
console.log("after delete:", children.size, children.has(first), children.has(second));
