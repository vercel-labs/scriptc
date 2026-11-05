import * as lib from "./lib.ts";
import * as reexported from "./reexport.ts";
import { bump } from "./counter.ts";
import { viaStringName } from "./named.ts";

console.log(viaStringName());

const tally = { total: 2 };
const name = ["sca", "le"].join("");
lib[name].call(tally, 5);
console.log(tally.total);

const counter = { count: 1 };
bump.call(counter, 1);
bump.call(counter, 2);
console.log(counter.count);

const amount = { value: 3 };
reexported[["dou", "ble"].join("")].call(amount);
console.log(amount.value);
