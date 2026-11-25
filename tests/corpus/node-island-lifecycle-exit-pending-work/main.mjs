// @exit: 3
// @requires-libnode
// process.exit from an island timer while native timers, an interval and an
// unresolved await are pending.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

process.on("exit", (code) => log(`native exit listener ${code}`));
setInterval(() => {}, 1000);
setTimeout(() => log("NOT REACHED"), 500);
(async () => {
  try {
    await new Promise(() => {});
  } finally {
    log("NOT REACHED finally");
  }
})();
lib.timerCb(10, () => {
  log("native callback in island timer exits");
  process.exit(3);
});
log("main end");
