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
