// A callback exception the program catches does not strand the grant when the
// request has a signal: Node releases the grant before the rejection, so a
// later same-name request runs. Without a signal Node keeps the grant held,
// and a later same-name request waits until a steal clears it.
import { locks } from "node:worker_threads";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

async function settled(promise) {
  try {
    return ["resolved", await promise];
  } catch (error) {
    return ["rejected", error.name, error.message];
  }
}

const sync = new AbortController();
console.log(
  "sync throw",
  ...(await settled(
    locks.request("caught-sync", { signal: sync.signal }, () => {
      throw new Error("sync");
    }),
  )),
);
console.log("sync later", await locks.request("caught-sync", () => "sync later"));

const later = new AbortController();
console.log(
  "async throw",
  ...(await settled(
    locks.request("caught-async", { signal: later.signal }, async () => {
      await tick();
      throw new Error("async");
    }),
  )),
);
console.log("async later", await locks.request("caught-async", () => "async later"));

const rejected = new AbortController();
console.log(
  "rejected promise",
  ...(await settled(
    locks.request("caught-reject", { signal: rejected.signal }, () => Promise.reject(new Error("rejected"))),
  )),
);
console.log("rejected later", await locks.request("caught-reject", () => "rejected later"));

console.log(
  "plain throw",
  ...(await settled(
    locks.request("caught-plain", () => {
      throw new Error("plain");
    }),
  )),
);
const waiting = locks.request("caught-plain", () => "granted after steal");
let waitingState = "pending";
await Promise.race([
  settled(waiting).then(([state]) => {
    waitingState = state;
  }),
  tick(),
]);
const plain = await locks.query();
console.log(
  "plain later",
  waitingState,
  "held",
  plain.held.filter((lock) => lock.name === "caught-plain").length,
  "pending",
  plain.pending.filter((lock) => lock.name === "caught-plain").length,
);
await locks.request("caught-plain", { steal: true }, () => "cleared");
console.log("plain cleared", await waiting);

let release;
const holder = locks.request("caught-queued", () => new Promise((resolve) => (release = resolve)));
const queuedSignal = new AbortController();
const queued = locks.request("caught-queued", { signal: queuedSignal.signal }, () => {
  throw new Error("queued");
});
queued.catch(() => {});
await tick();
release();
await holder;
console.log("queued throw", ...(await settled(queued)));
console.log("queued later", await locks.request("caught-queued", () => "queued later"));

let releaseShared;
const sharedHolder = locks.request(
  "caught-shared",
  { mode: "shared" },
  () => new Promise((resolve) => (releaseShared = resolve)),
);
await tick();
const sharedSignal = new AbortController();
console.log(
  "shared throw",
  ...(await settled(
    locks.request("caught-shared", { mode: "shared", signal: sharedSignal.signal }, () => {
      throw new Error("shared");
    }),
  )),
);
console.log(
  "shared later",
  await locks.request("caught-shared", { mode: "shared" }, () => "shared later"),
);
releaseShared();
await sharedHolder;

const nestedSignal = new AbortController();
let inner = "pending";
console.log(
  "nested throw",
  ...(await settled(
    locks.request("caught-nested", { signal: nestedSignal.signal }, () => {
      locks.request("caught-nested", () => "inner").then(
        (value) => {
          inner = value;
        },
        () => {
          inner = "rejected";
        },
      );
      throw new Error("nested");
    }),
  )),
);
await tick();
console.log("nested inner", inner);
console.log("nested later", await locks.request("caught-nested", () => "nested later"));
