// Steal aborts every current holder with an AbortError and clears the name;
// requests already queued keep waiting for the steal's own release, and a
// later plain request is granted. A grant an earlier callback throw left
// behind is stolen the same way.
import { locks } from "node:worker_threads";

async function outcome(promise) {
  try {
    return ["resolved", await promise];
  } catch (error) {
    return ["rejected", error.name, error.message];
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

let release;
const held = new Promise((resolve) => (release = resolve));
const holder = locks.request("steal", () => held);
const queued = locks.request("steal", () => "queued");
await tick();

const before = await locks.query();
console.log(
  "before held",
  before.held.map((lock) => lock.name).join(","),
  "pending",
  before.pending.map((lock) => lock.name).join(","),
);

const stolen = locks.request("steal", { steal: true }, (lock) => `${lock.name} ${lock.mode}`);
console.log("holder", ...(await outcome(holder)));
console.log("steal", ...(await outcome(stolen)));
console.log("queued", ...(await outcome(queued)));
release();
await tick();

const after = await locks.query();
console.log("after held", after.held.length, "pending", after.pending.length);
console.log("later", await locks.request("steal", () => "later"));

try {
  await locks.request("leak", () => {
    throw new Error("leak");
  });
} catch (error) {
  console.log("leak rejected", error.message);
}
console.log("leak held", (await locks.query()).held.filter((lock) => lock.name === "leak").length);
await locks.request("leak", { steal: true }, () => "cleared");
console.log("leak cleared", (await locks.query()).held.filter((lock) => lock.name === "leak").length);
console.log("leak later", await locks.request("leak", () => "granted"));

let releaseShared;
const sharedHeld = new Promise((resolve) => (releaseShared = resolve));
const first = locks.request("shared", { mode: "shared" }, () => sharedHeld);
await tick();
const second = locks.request("shared", { mode: "shared" }, () => sharedHeld);
await tick();
const sharedHeldRows = (await locks.query()).held.filter((lock) => lock.name === "shared");
console.log("shared rows", sharedHeldRows.length, sharedHeldRows.map((lock) => lock.mode).join(","));
const sharedSteal = locks.request("shared", { steal: true }, () => "shared stolen");
console.log("shared first", ...(await outcome(first)));
console.log("shared second", ...(await outcome(second)));
console.log("shared steal", ...(await outcome(sharedSteal)));
releaseShared();
await tick();
console.log("shared end", (await locks.query()).held.filter((lock) => lock.name === "shared").length);
