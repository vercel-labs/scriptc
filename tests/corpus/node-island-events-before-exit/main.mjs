// @requires-libnode
// beforeExit listeners of island code, one of them a native callback, run
// each time the loop runs dry, with the exit code so far. Work a listener
// schedules on either side (a native timer, an island timer, a native
// promise job that arms a timer) keeps the process going and beforeExit
// fires again; the exit listeners of both sides run once, at the end.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

let round = 0;
lib.onBeforeExit((code) => {
  round++;
  log(`native callback beforeExit ${round} code=${code}`);
  if (round === 1) setTimeout(() => log("native timer armed in beforeExit"), 1);
  else if (round === 2) lib.timer(1, "island timer armed in beforeExit");
  else if (round === 3) Promise.resolve().then(() => setTimeout(() => log("native timer armed by a job"), 1));
});
lib.listen("second");
process.on("exit", (code) => log(`native exit ${code} after ${round} rounds`));
lib.onExit();
log(`count ${lib.count()}`);
setTimeout(() => log("first timer"), 1);
log("main end");
