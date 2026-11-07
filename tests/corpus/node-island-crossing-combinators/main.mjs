// @requires-libnode
// Promise combinators over promises from both sides, run by each side, and
// rejections handled by one side only: nothing is reported as unhandled.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (...a) => console.log(...a);
const delayed = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
const failing = (ms, m) => new Promise((_, r) => setTimeout(() => r(new Error(m)), ms));

const mix = () => [delayed(30, "n30"), lib.delayed(10, "i10"), lib.now("i0"), Promise.resolve("n0"), 7];
const mixFail = () => [failing(20, "n-fail"), lib.failing(5, "i-fail"), lib.delayed(40, "i40")];
const sides = (native, island) => [["native", native], ["island", island]];

async function main() {
  for (const [who, run] of sides((ps) => Promise.all(ps), lib.all)) {
    log(who, "all", (await run(mix())).join(" "));
    try {
      await run(mixFail());
    } catch (e) {
      log(who, "all rejected", e.message, e instanceof Error);
    }
  }
  log("island race", await lib.race([delayed(10, "n10"), lib.delayed(30, "i30")]));
  log("island race", await lib.race([delayed(30, "n30"), lib.delayed(10, "i10")]));
  log("island race settled", await lib.race([lib.now("i0"), Promise.resolve("n0")]));
  log("island race settled", await lib.race([Promise.resolve("n0"), lib.now("i0")]));
  try {
    await lib.race([lib.failing(5, "race i-fail"), delayed(30, "n30")]);
  } catch (e) {
    log("island race rejected", e.message);
  }
  for (const [who, run] of sides((ps) => Promise.allSettled(ps), lib.settled)) {
    const r = await run(mixFail());
    log(who, "settled", r.map((x) => (x.status === "fulfilled" ? x.value : `!${x.reason.message}`)).join(" "));
  }
  for (const [who, run] of sides((ps) => Promise.any(ps), lib.any)) {
    log(who, "any", await run(mixFail()));
    try {
      await run([failing(5, "a"), lib.failing(1, "b")]);
    } catch (e) {
      log(who, "any rejected", e.name, e instanceof Error, e.errors.map((x) => x.message).join(","));
    }
  }
  // Already settled entries of both sides: the first rejection in input order wins.
  for (const [who, run] of sides((ps) => Promise.all(ps), lib.all)) {
    for (const ps of [[Promise.reject(new Error("n first")), lib.failed("i second")], [lib.failed("i first"), Promise.reject(new Error("n second"))]]) {
      try {
        await run(ps);
      } catch (e) {
        log(who, "all settled entries", e.message);
      }
    }
  }
  // Handled by island code only: the program holds the promise and never reacts to it.
  const held = lib.selfHandled(5, "held", log);
  const passed = lib.failing(5, "passed back");
  lib.swallow(passed, log);
  // Handled natively only.
  lib.failing(5, "native only").catch((e) => log("native handled", e.message));
  const native = failing(5, "native passed in");
  lib.swallow(native, log);
  await delayed(40);
  log("end", typeof held.then);
}

main();
