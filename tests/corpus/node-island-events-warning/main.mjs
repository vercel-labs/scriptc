// @requires-libnode
// @env: NODE_NO_WARNINGS=1
// 'warning' listeners of both sides are one list: process.emitWarning from
// native code, from a native callback island code calls, and from island
// code reaches all of them in registration order, on the next tick, and a
// listener that was removed gets none.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

const first = (w) => log(`native first: ${w.name}: ${w.message} ${w instanceof Error}`);
process.on("warning", first);
lib.listen("second");
process.on("warning", (w) => log(`native third: ${w.name}: ${w.message} code=${w.code}`));
log(`count ${lib.count()}`);

process.emitWarning("from native", "CustomWarning", "W001");
log("after the native emit");
process.emitWarning("with options", { type: "DetailWarning", code: "W002", detail: "more text" });
lib.call(() => process.emitWarning("from a native callback", "OtherWarning"));
lib.emit("from the island", "IslandWarning");
log("main end");
setTimeout(() => {
  process.off("warning", first);
  lib.unlisten("second");
  log(`count ${lib.count()}`);
  process.emitWarning("after removal", "LateWarning");
  lib.emit("island after removal", "LateWarning");
}, 20);
setTimeout(() => log("done"), 50);
