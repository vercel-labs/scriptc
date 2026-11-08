// @requires-libnode
// An await chain that crosses the boundary at every level, down and back
// up, and a rejection that unwinds through the finally blocks of both sides.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

async function nativeDown(n) {
  log(`native down ${n}`);
  if (n === 0) return "bottom";
  const r = await lib.down(n - 1, nativeDown);
  log(`native up ${n}`);
  return `n${n}(${r})`;
}

function failing(at) {
  return async function step(n) {
    try {
      if (n === at) throw new TypeError(`native failed at ${n}`);
      if (n === 0) return "bottom";
      return await lib.failAt(n - 1, at, step);
    } finally {
      log(`native finally ${n}`);
    }
  };
}

async function main() {
  log(await nativeDown(9));
  log(await lib.down(8, nativeDown));
  for (const at of [0, 1, 4, 7]) {
    try {
      log(await failing(at)(8));
    } catch (e) {
      log(`caught ${e.name}: ${e.message} ${e instanceof TypeError} ${e instanceof RangeError}`);
    }
  }
}

main();
