// A callback that throws settles the request with Node's converted value: the
// value's message is read first (so a proxy trap or an accessor that throws
// becomes the reason), a LOCK_STOLEN message becomes an AbortError, and every
// other value stays the reason. The same conversion runs for an async
// callback's rejection.
import { locks } from "node:worker_threads";

const trap = new Proxy({}, { get() { throw new Error("trap get"); } });

try {
  await locks.request("proxy", () => {
    throw trap;
  });
  console.log("proxy resolved");
} catch (error) {
  console.log("proxy rejected", error.name, error.message);
}

try {
  await locks.request("getter", () => {
    throw { get message() { throw "again"; } };
  });
  console.log("getter resolved");
} catch (error) {
  console.log("getter rejected", typeof error, error);
}

try {
  await locks.request("sentinel", () => {
    throw new Error("LOCK_STOLEN");
  });
  console.log("sentinel resolved");
} catch (error) {
  console.log("sentinel rejected", error.name, error.message);
}

try {
  await locks.request("null", () => {
    throw null;
  });
  console.log("null resolved");
} catch (error) {
  console.log("null rejected", error === null);
}

try {
  await locks.request("async", () => Promise.reject(trap));
  console.log("async resolved");
} catch (error) {
  console.log("async rejected", error.name, error.message);
}

const symbol = Symbol("thrown");
try {
  await locks.request("symbol", () => {
    throw symbol;
  });
  console.log("symbol resolved");
} catch (error) {
  console.log("symbol rejected", typeof error, error === symbol);
}

try {
  await locks.request("bigint", () => {
    throw 10n;
  });
  console.log("bigint resolved");
} catch (error) {
  console.log("bigint rejected", typeof error, error === 10n);
}

const snapshot = await locks.query();
console.log(
  "held",
  snapshot.held.map((lock) => lock.name).sort().join(","),
  "pending",
  snapshot.pending.length,
);
