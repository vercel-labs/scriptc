// @requires-libnode
// The program's generators in island code: for...of, spread, destructuring,
// Array.from, manual next/return/throw, for await over a sync and an async
// generator, and yield* through an island generator back into the program.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

function* numbers(label, n) {
  try {
    for (let i = 1; i <= n; i++) {
      const sent = yield i;
      if (sent !== undefined) log(`${label} received ${sent}`);
    }
    return `${label} done`;
  } finally {
    log(`${label} finally`);
  }
}
function* catches() {
  try {
    yield 1;
  } catch (e) {
    log(`generator caught: ${e.message}`);
    yield 2;
  }
}
async function* later(label, n) {
  try {
    for (let i = 1; i <= n; i++) {
      await null;
      yield i * 10;
    }
  } finally {
    log(`${label} finally`);
  }
}

async function main() {
  log(lib.describe(numbers("describe", 1)));
  log(lib.describeAsync(later("describeAsync", 1)));
  log(`take ${lib.take(numbers("take", 5), 2)}`);
  log(`all ${lib.all(numbers("all", 3))}`);
  log(`destructure ${lib.destructure(numbers("destructure", 5))}`);
  log(`from ${lib.from(numbers("from", 3))}`);
  log(`manual ${lib.manual(numbers("manual", 5))}`);
  log(`throw ${lib.throwInto(catches())}`);
  log(`async take ${await lib.takeAsync(later("async take", 5), 2)}`);
  log(`async over sync ${await lib.awaitSync(numbers("async over sync", 2))}`);
  for (const v of lib.yieldStar(numbers("delegated", 2))) log(`native got ${v}`);
  log("end");
}

main();
