// Reflect.get over runtime handles: a Map's size, a Date method, a URL's
// href, a stream's locked getter, a database's class getters and methods
// and its limits answer as Node's do, and a missing member is undefined.
import { DatabaseSync } from "node:sqlite";

const map = new Map<string, number>([["k", 1]]);
const date = new Date(0);
const url = new URL("http://example.com/path");
const stream = new ReadableStream();

console.log("map", Reflect.get(map as unknown as object, "size"));
console.log("map-missing", Reflect.get(map as unknown as object, "k"));
const dateGetter = Reflect.get(date as unknown as object, "getTime");
console.log("date", typeof dateGetter);
console.log("date-value", typeof dateGetter === "function" ? (dateGetter as () => number).call(date) : "none");
console.log("url", Reflect.get(url as unknown as object, "href"));
console.log("stream", Reflect.get(stream as unknown as object, "locked"));

const db = new DatabaseSync(":memory:");
const stmt = db.prepare("SELECT 1 AS a");
const limits = db.limits;
console.log("db-isOpen", Reflect.get(db as unknown as object, "isOpen"));
console.log("db-missing", Reflect.get(db as unknown as object, "nope"));
console.log("db-method", typeof Reflect.get(db as unknown as object, "prepare"));
console.log("stmt", Reflect.get(stmt as unknown as object, "sourceSQL"));
console.log("limits-length", Reflect.get(limits as unknown as object, "length"));
console.log("has", Reflect.has(db as unknown as object, "isOpen"), Reflect.has(db as unknown as object, "nope"));
db.close();

// An explicit receiver: a class accessor reads the receiver's state, and a
// receiver that is not an instance of the class is its TypeError.
const failure = (label: string, run: () => unknown): void => {
  try {
    console.log(label, "ok", String(run()));
  } catch (error) {
    const e = error as { name: string; code?: string; message: string };
    console.log(label, "ERR", e.name, e.code, e.message);
  }
};
const bigMap = new Map<string, number>([["a", 1], ["b", 2], ["c", 3]]);
console.log("map-receiver", Reflect.get(map as unknown as object, "size", bigMap as unknown as object));
failure("map-bad-receiver", () => Reflect.get(map as unknown as object, "size", {}));
const otherUrl = new URL("http://b/");
console.log("url-receiver", Reflect.get(url as unknown as object, "href", otherUrl));
failure("url-bad-receiver", () => Reflect.get(url as unknown as object, "href", {}));
const otherDb = new DatabaseSync(":memory:");
console.log("db-receiver", Reflect.get(db as unknown as object, "isOpen", otherDb as unknown as object));
failure("db-bad-receiver", () => Reflect.get(db as unknown as object, "isOpen", {}));
otherDb.close();
const otherStream = new ReadableStream();
console.log("stream-receiver", Reflect.get(stream as unknown as object, "locked", otherStream as unknown as object));
failure("stream-bad-receiver", () => Reflect.get(stream as unknown as object, "locked", {}));

// An own property of the target shadows its class getter; a receiver's own
// shadow is not consulted when the target's inherited getter runs with it.
const requestTarget = new Request("http://example.com/t");
const requestReceiver = new Request("http://example.com/r");
Object.defineProperty(requestTarget, "url", {
  value: "own-shadow",
  writable: true,
  enumerable: true,
  configurable: true,
});
Object.defineProperty(requestReceiver, "url", {
  value: "receiver-shadow",
  writable: true,
  enumerable: true,
  configurable: true,
});
console.log("own-target", Reflect.get(requestTarget as unknown as object, "url", {}));
console.log("own-target-receiver", Reflect.get(requestTarget as unknown as object, "url", requestReceiver as unknown as object));
const plainRequest = new Request("http://example.com/p");
console.log("receiver-shadow-ignored", Reflect.get(plainRequest as unknown as object, "url", requestReceiver as unknown as object));

// A Response body is a ReadableStream instance for the stream getters.
const responseForBody = new Response("x");
console.log("body-receiver", Reflect.get(new ReadableStream() as unknown as object, "locked", responseForBody.body as unknown as object));

// An accessor that rejects answers a rejected promise, not a throw, for an
// incompatible receiver.
const closedReader = new ReadableStream().getReader();
(Reflect.get(closedReader as unknown as object, "closed", {}) as Promise<unknown>).then(
  () => console.log("reader-closed-bad resolved"),
  (error) => {
    const e = error as { name: string; code?: string; message: string };
    console.log("reader-closed-bad", e.name, e.code, e.message);
  },
);
const readyWriter = new WritableStream().getWriter();
(Reflect.get(readyWriter as unknown as object, "ready", null) as Promise<unknown>).then(
  () => console.log("writer-ready-bad resolved"),
  (error) => {
    const e = error as { name: string; code?: string; message: string };
    console.log("writer-ready-bad", e.name, e.code, e.message);
  },
);
