// locks.query() answers the calling thread's held and pending locks; on an
// idle manager both are empty.
import { locks } from "node:worker_threads";

const first = await locks.query();
const second = await locks.query();
console.log("idle", first.held.length, second.pending.length);
