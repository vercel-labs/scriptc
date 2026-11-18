import "./caller.js";
import { optional, defaulted, Counter } from "./lib.ts";

const counter = new Counter();
console.log("ts-call", optional(), optional("y"), defaulted(), defaulted("y"));
console.log("ts-method", counter.set(), counter.set("y"));

// The function as a value keeps the argument list its caller passes (the
// checked-dynamic call hands the closure every argument).
const held = defaulted;
console.log("ts-value", held(), held("y"));
