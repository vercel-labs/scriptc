// @requires-libnode
// Cross-heap cycles through a shared module (scope-B NI-8): island code
// pairs native sessions of a program module it shares with island peers
// that point back at them. The pairs island code drops are garbage on both
// sides; the ones the shared module keeps stay alive and keep working.
import { requireModule } from "@scriptc/node";
import { openSessions } from "./sessions.mjs";

const { churn, pair } = requireModule("./peers.mjs");

let total = 0;
for (let i = 0; i < 3000; i++) {
  total += pair(i, i % 500 === 0);
  churn(4);
}
console.log("total", total);
const open = openSessions();
console.log("open", open.length, open.map((s) => s.id).join(","));
console.log("sent", open.map((s) => s.send("again")).join(","));
console.log("logs", open.map((s) => s.log.length).join(","));
