// The callbacks keep their registration position among the program's own
// 'exit'/'beforeExit' listeners (the runtime installs its listener on the
// first registration), a registration made from inside a callback runs in
// the same drain, and an explicit process.exit() runs the 'exit' list only —
// registerBeforeExit callbacks never see that path.
import { spawnSync } from "node:child_process";

const mode = process.argv[2];

if (mode === "natural") {
  process.on("beforeExit", () => console.log("user-beforeExit-1"));
  const a = { name: "a" };
  process.finalization.registerBeforeExit(a, (ref, event) => {
    console.log("fin-beforeExit", event, ref === a);
    process.finalization.registerBeforeExit({ name: "late" }, (_lateRef, lateEvent) =>
      console.log("fin-late", lateEvent),
    );
  });
  process.on("beforeExit", () => console.log("user-beforeExit-2"));
  process.on("exit", () => console.log("user-exit"));
} else if (mode === "explicit") {
  const b = { name: "b" };
  process.finalization.registerBeforeExit(b, (_ref, event) => console.log("bx-cb", event));
  process.finalization.register({ name: "c" }, (_ref, event) => console.log("exit-cb", event));
  console.log("exiting");
  process.exit(4);
} else {
  for (const child of ["natural", "explicit"]) {
    const result = spawnSync(process.execPath, [process.argv[1], child], { encoding: "utf8" });
    console.log(child, "status", result.status);
    console.log(JSON.stringify(result.stdout));
  }
}
