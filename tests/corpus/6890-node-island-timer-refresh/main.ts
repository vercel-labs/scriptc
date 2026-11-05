// @requires-libnode
// refresh() of a timer armed before Node loads restarts it with the delay
// it was created with, not the remaining delay it had at handoff: a due
// timer it refreshes does not run before Node's loop starts. The timer
// armed after the refresh fires first.
import { callSync } from "@scriptc/node";

const slow = setTimeout(() => console.log("slow"), 1000);
// Most of the timer's delay passes before Node loads, so its runtime entry
// reaches the hosted loop with little time left (or already due).
const start = Date.now();
while (Date.now() - start < 800) {}
console.log("loaded", callSync<number>("./echo.cjs", "echo", 1));
slow.refresh();
setTimeout(() => console.log("fast"), 400);
