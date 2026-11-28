// A lock callback that throws answers Node's rejection, and Node keeps the
// lock held afterwards: the query reports the holder and nothing pending.
import { locks } from "node:worker_threads";

try {
  await locks.request("throw", () => {
    throw new Error("boom");
  });
  console.log("resolved");
} catch (error) {
  console.log("rejected", error.message);
}
const snapshot = await locks.query();
console.log("held", snapshot.held.length, "pending", snapshot.pending.length);
