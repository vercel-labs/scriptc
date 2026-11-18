// An untyped caller reaches the same typed functions: the dynamic call
// passes the arguments this call site wrote, so the count is the same one
// the JavaScript it replaced would see.
import { optional, defaulted, Counter } from "./lib.ts";

const counter = new Counter();
console.log("js-call", optional(), optional("y"), defaulted(), defaulted("y"));
console.log("js-method", counter.set(), counter.set("y"));
const held = defaulted;
console.log("js-value", held(), held("y"));
