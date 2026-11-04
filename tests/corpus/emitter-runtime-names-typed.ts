// TypeScript: string-typed event names reach listeners with typed parameters
// registered under literal names, and literal emits reach listeners
// registered under string-typed names.
import { EventEmitter } from "node:events";
const ee = new EventEmitter();
ee.on("sum", (a: number, b: number) => console.log("literal sum", a + b));
ee.emit("sum", 1, 2);
const pick = (i: number): string => ["sum", "label"][i]!;
ee.emit(pick(0), 3, 4);
ee.on(pick(1), (text: string) => console.log("runtime label", text.toUpperCase()));
ee.emit("label", "hi");
ee.emit(pick(1), "there");
console.log(ee.listenerCount(pick(0)), ee.eventNames().join(","));
