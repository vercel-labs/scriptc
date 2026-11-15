// @requires-libnode
// Natively compiled CommonJS packages that bind an island package's module
// with `var` or `let` (the whole module, or its members by a pattern) and
// never write the binding again: every use crosses into the island, in
// module-level code and inside functions, for a call, a construction, a
// caught island error and a member passed on as an argument.
import { firstLabel, jarText, grams, missing } from "shelf-whole";
import { total, labelVia, jarOf } from "shelf-parts";

console.log(firstLabel(), jarText());
console.log(grams(["salt", "rice"]).join(","), missing("saffron"));
console.log(total("rice"), jarOf("rice", 2));
console.log(labelVia((find) => find("flour").label));
