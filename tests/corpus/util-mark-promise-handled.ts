// util.markPromiseAsHandled marks a promise's rejection observed so the
// loop reports no 'unhandledRejection' for it — whether it has already
// rejected or rejects later — while a rejection nobody marked is still
// reported once. The call answers undefined.
import { markPromiseAsHandled } from "node:util";

const seen: string[] = [];
process.on("unhandledRejection", (reason) => {
  seen.push(reason instanceof Error ? reason.message : String(reason));
});

const marked: Promise<number> = Promise.reject(new Error("marked"));
markPromiseAsHandled(marked);

async function failLater(): Promise<number> {
  await Promise.resolve(1);
  throw new Error("marked later");
}
const markedLater = failLater();
markPromiseAsHandled(markedLater);

// Marking twice is harmless, and the promise is still awaitable.
const twice: Promise<number> = Promise.reject(new Error("twice"));
markPromiseAsHandled(twice);
markPromiseAsHandled(twice);

const unmarked: Promise<number> = Promise.reject(new Error("unmarked"));

setTimeout(() => {
  console.log("seen", [...seen].sort().join(","));
  console.log("done");
}, 20);
