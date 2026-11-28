// Two shared holders of one name are granted together; an exclusive request
// then takes it alone.
import { locks } from "node:worker_threads";

const modes = await Promise.all([
  locks.request("shared", { mode: "shared" }, (lock) => lock.mode),
  locks.request("shared", { mode: "shared" }, (lock) => lock.mode),
]);
console.log("shared", JSON.stringify(modes));
