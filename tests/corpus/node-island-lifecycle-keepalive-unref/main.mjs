// @requires-libnode
// What keeps the process alive: an island timer does, an unref'd island
// timer, interval and server do not, a native unref'd timer does not, and an
// island Timeout unref'd through its native handle does not.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

lib.unrefTimer(300);
lib.unrefInterval();
lib.unrefServer();
setTimeout(() => log("NOT REACHED native unref timer"), 300).unref();
const t = lib.refTimer(300, "NOT REACHED: unref'd natively");
t.unref();
lib.refTimer(30, "keeps alive until 30 ms");
lib.rerefTimer(50);
process.on("exit", (code) => log(`exit ${code} interval ran ${lib.ticked()}`));
log("main end");
