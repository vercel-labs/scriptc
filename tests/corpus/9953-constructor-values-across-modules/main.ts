// A constructor value is one function for the whole program: a TypeScript
// module hands String, Number, Boolean and BigInt to a JavaScript module,
// which compares them with its own, calls them with every kind of argument,
// and hands its own back.
import { describe, kindOf, pickByName, table } from "./probe.mjs";

const held = { text: String, amount: Number, flag: Boolean, big: BigInt };
console.log(kindOf(String), kindOf(held.amount), kindOf(held.flag), kindOf(BigInt), kindOf((v: string) => v));
console.log(describe(held.text), describe(Number), describe(held.flag), describe(held.big));
console.log(pickByName("String") === String, pickByName("Number") === held.amount);
console.log(pickByName("Boolean") === Boolean, pickByName("BigInt") === BigInt);
console.log(table.text === String, table.amount === Number, table.flag === held.flag);

const handlers: unknown[] = [String, Number, Boolean];
console.log(handlers.map((fn) => kindOf(fn)).join(","), handlers.indexOf(Number), handlers.includes(Boolean));
