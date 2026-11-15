// @exit: 1
// @requires-libnode
// A native callback run by an island timer throws with no listener: exit 1
// after the exit listeners of both sides, and no later work runs.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
process.on("exit", (code) => console.log(`native exit listener ${code}`));
lib.onExit();
setTimeout(() => console.log("NOT REACHED"), 50);
lib.later(5, () => {
  console.log("native callback throws");
  throw new Error("native boom in island timer");
});
