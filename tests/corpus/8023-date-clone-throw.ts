// Dates through structuredClone and MessageChannel, which copy them as
// new Dates with the same time value, and Dates thrown and rejected as
// values, which keep their identity.
import { MessageChannel } from "node:worker_threads";
process.env.TZ = "UTC";

const at = new Date(Date.UTC(2026, 9, 23, 7));
const copy = structuredClone(at);
console.log(copy instanceof Date, copy === at, copy.getTime() === at.getTime());
copy.setUTCFullYear(2000);
console.log(at.getUTCFullYear(), copy.getUTCFullYear());

const nested = structuredClone({ at, list: [at, at], invalid: new Date(Number.NaN) });
console.log(nested.list[0] instanceof Date, nested.at === at, nested.list.length);
console.log(nested.at.toISOString(), Number.isNaN(nested.invalid.getTime()));

try {
  throw at;
} catch (error) {
  console.log(error instanceof Date, error === at);
}

const { port1, port2 } = new MessageChannel();
port2.on("message", (data: { when: Date; again: Date }) => {
  const { when, again } = data;
  console.log("message", when instanceof Date, when === at, again instanceof Date, when.toISOString());
  port2.close();
  Promise.reject(at).catch((reason: unknown) => {
    console.log("rejected", reason instanceof Date, reason === at);
  });
});
port1.postMessage({ when: at, again: at });
