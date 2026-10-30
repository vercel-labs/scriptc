// @requires-libnode
// A timer on Node's loop runs runtime code deep below the callback's own
// frame, and an async function it starts calls into Node.js before its
// first await: that call's frames go below the deepest live runtime frame
// on Node's stack, so the frames above it return intact.
import { callSync } from "@scriptc/node";

async function viaNode(n: number): Promise<number> {
  const echoed = callSync<number>("./echo.cjs", "echo", n);
  await null;
  return echoed;
}

const started: Promise<number>[] = [];
function deep(depth: number, n: number): number {
  const local = [depth, n, depth * n];
  if (depth > 0) return deep(depth - 1, n) + local[2]!;
  started.push(viaNode(n));
  return local[0]! + local[1]!;
}

console.log("loaded", callSync<number>("./echo.cjs", "echo", 1));
setTimeout(() => {
  console.log("deep", deep(200, 3));
  void Promise.all(started).then((values) => console.log("echoed", values.join(",")));
}, 0);
