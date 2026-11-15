// @requires-libnode
// Awaiting across the boundary takes the microtask turns it takes in Node:
// an island promise awaited natively, a native promise awaited in island
// code, and chains that cross at each level, against a chain of turns.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

function turns(tag, n) {
  let p = Promise.resolve();
  for (let i = 1; i <= n; i++) p = p.then(() => log(`${tag} turn ${i}`));
  return p;
}

async function flat() {
  const t = turns("flat", 5);
  (async () => {
    log(`flat island ${await lib.resolved(1)}`);
    log(`flat island again ${await lib.resolved(2)}`);
  })();
  (async () => {
    log(`flat native ${await Promise.resolve(1)}`);
    log(`flat native again ${await Promise.resolve(2)}`);
  })();
  (async () => {
    try {
      await lib.rejected("no");
    } catch (e) {
      log(`flat rejected ${e.message}`);
    }
  })();
  await t;
}

async function nested() {
  const t = turns("nested", 9);
  const inner = async () => {
    log("nested native inner");
    const v = await lib.resolved(10);
    log(`nested native inner after ${v}`);
    return v + 1;
  };
  (async () => {
    const v = await lib.through(inner, "nested", log);
    log(`nested outer after ${v}`);
    const w = await lib.through(async () => (await lib.through(inner, "deep", log)) + 1, "deeper", log);
    log(`nested outer deep after ${w}`);
  })();
  await t;
}

async function reactions() {
  const t = turns("reactions", 4);
  const p = lib.resolved("p");
  lib.then(p, (v) => log(`reactions island then ${v}`));
  p.then((v) => log(`reactions native then ${v}`));
  (async () => log(`reactions native await ${await p}`))();
  const q = lib.resolved("q");
  q.then((v) => log(`reactions native first ${v}`));
  lib.then(q, (v) => log(`reactions island second ${v}`));
  await t;
}

async function macrotask() {
  const order = [];
  const p = lib.later("later");
  setImmediate(() => order.push("immediate"));
  const v = await p;
  order.push(`awaited ${v}`);
  await new Promise((resolve) => setImmediate(resolve));
  log(`macrotask ${order.join(", ")}`);
}

await flat();
await nested();
await reactions();
await macrotask();
log("done");
