// @requires-libnode
// Promises both ways on one microtask queue (scope-B NI-5): island
// promises awaited natively and native promises awaited in the island
// interleave with both sides' reactions exactly as in Node.
import { requireModule } from "@scriptc/node";

const { catches, chain, consume, isPromise, later, rejectsWith, resolved, timer } =
  requireModule("./lib.cjs");

async function nativeValue(n) {
  await null;
  console.log("native resolving", n);
  return n;
}

async function main() {
  console.log("start");
  Promise.resolve().then(() => console.log("native tick 1"));
  const p = later("a");
  Promise.resolve().then(() => console.log("native tick 2"));
  console.log("awaited", await p);

  console.log("resolved", await resolved(41));
  try {
    await rejectsWith("bad input");
  } catch (e) {
    console.log("rejected", e instanceof TypeError, e.message);
  }

  // A native promise passed into the island is a real Promise there.
  const mine = nativeValue(21);
  console.log("isPromise", isPromise(mine));
  Promise.resolve().then(() => console.log("native tick 3"));
  console.log("consume", await consume(mine));
  console.log("chain", await chain(nativeValue(1)));
  console.log("catches", await catches(Promise.reject(new RangeError("native rejection"))));
  console.log("catches", await catches(nativeValue(2)));

  const [x, y] = await Promise.all([timer(10, "slow"), timer(1, "fast")]);
  console.log("all", x, y);
  console.log("timer", await timer(2, "early"));
  console.log("end");
}

main();
