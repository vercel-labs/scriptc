// Warnings native code emits after Node loaded print as Node prints them:
// the code, the detail line and the one-time hint; a deprecation is silent
// while process.noDeprecation is set and prints again once it is cleared.
import { callSync } from "@scriptc/node";

callSync("./island.cjs", "onExit", "a");
process.emitWarning("with detail", { type: "CustomWarning", code: "X1", detail: "more" });
process.emitWarning("silenced", "DeprecationWarning");
process.noDeprecation = true;
setTimeout(() => {
  process.noDeprecation = false;
  process.emitWarning("printed", "DeprecationWarning");
}, 10);
