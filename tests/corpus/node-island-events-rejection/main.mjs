// @requires-libnode
// unhandledRejection listeners of both sides are one list and receive the
// rejections of both sides, with the reason and the promise (for native
// listeners the native error and promise themselves): a native promise
// nobody handles, an island promise nobody handles, an island promise native
// code only holds, and a native promise island code only holds. Each
// rejection is reported once, and one the other side handles is not
// reported.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

class Failure extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let held;
let why;
let events = 0;
process.on("unhandledRejection", (reason, promise) => {
  events++;
  const status = reason instanceof Failure ? ` status=${reason.status}` : "";
  log(`native first: ${reason.message} ${promise instanceof Promise} held=${promise === held} why=${reason === why}${status}`);
});
lib.listen("second");
const once = (reason) => log(`native once: ${reason.message}`);
process.once("unhandledRejection", once);
lib.listenCallback((reason, promise) => log(`native callback, island registered: ${reason.message} ${typeof promise}`));
log(`count ${lib.count()}`);

const steps = [
  () => {
    why = new RangeError("native, nobody");
    held = Promise.reject(why);
  },
  () => {
    why = undefined;
    lib.rejectNow("island, nobody");
  },
  () => {
    held = lib.rejected("island, native holds");
  },
  () => {
    // The reason of a promise that crossed before Node reports it is still
    // the native error, with its class and fields.
    why = new Failure("native, island holds", 7);
    held = Promise.reject(why);
    lib.hold(held);
  },
  () => {
    held = undefined;
    why = undefined;
    // Handled on the other side: no event.
    lib.rejected("island, native catches").catch((e) => log(`native caught: ${e.message}`));
  },
  () => lib.swallow(Promise.reject(new Error("native, island catches"))),
  () => {
    // Native code handles a native promise island code only holds, with the
    // handler attached before and after the promise crossed: no event.
    const first = new Promise((_, reject) => setTimeout(() => reject(new Error("native catches, island holds")), 5));
    first.catch((e) => log(`native caught: ${e.message}`));
    lib.hold(first);
    const late = new Promise((_, reject) => setTimeout(() => reject(new Error("island holds, native catches later")), 5));
    lib.hold(late);
    late.catch((e) => log(`native caught: ${e.message}`));
  },
  () => {
    // A pending native promise island code holds, rejected later.
    why = new Failure("native, pending when the island took it", 8);
    held = new Promise((_, reject) => setTimeout(() => reject(why), 5));
    lib.hold(held);
  },
  () => {
    const fails = async () => {
      throw new Error("native async function");
    };
    held = fails();
  },
  () => log(`events ${events} count ${lib.count()}`),
];
setTimeout(function run() {
  if (steps.length > 1) setTimeout(run, 25);
  steps.shift()();
}, 5);
