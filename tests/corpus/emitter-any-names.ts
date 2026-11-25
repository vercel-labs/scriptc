// Event names read through an untyped value key the listener table by
// String(name), as in Node.
import { EventEmitter } from "node:events";

const ee = new EventEmitter();
const raw: any = JSON.parse('{"text":"alpha","number":42,"flag":true}');
const text: any = raw.text;
const number: any = raw.number;
const flag: any = raw.flag;

ee.on(text, (v: number) => console.log("alpha", v));
ee.emit(text, 1);
ee.on(number, (v: string) => console.log("42", v));
ee.emit(number, "x");
ee.emit("42", "y");
ee.on(flag, () => console.log("true fired"));
ee.emit("true");
console.log(ee.listenerCount(number), ee.listenerCount(text));

ee.once(raw.text, (v: number) => console.log("once alpha", v));
ee.emit("alpha", 3);
ee.emit("alpha", 4);
ee.emit(text, 5);
ee.removeAllListeners(text);
console.log(ee.listenerCount(text), ee.eventNames().join(","));
