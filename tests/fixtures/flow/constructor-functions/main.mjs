import { counting, early, optional, ordered, others, plain, withMethod } from "./points.js";
import { viaAlias } from "./alias.js";
import * as prototype from "./prototype.js";

console.log(JSON.stringify(plain()), withMethod(), JSON.stringify(early()), JSON.stringify(counting()));
console.log(JSON.stringify(optional()), "size" in optional(), JSON.stringify(others()));
console.log(viaAlias());
const [swapped, later] = ordered();
console.log(JSON.stringify(swapped), Object.keys(swapped).join(), JSON.stringify(later));

const key = ["Named", "Thing"].join("");
prototype[key].prototype.title = "dr";
console.log(prototype.make("ada").title);
