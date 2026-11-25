// @requires-libnode
// A CommonJS package binds an island package's module with `var`, uses
// the binding while its module evaluates and writes it again inside a
// function. Its uses cannot cross natively, and the build sees that only
// in the round that follows the island's own discovery: that round's
// fences are read too, so the importer runs in the island instead of the
// binary throwing when it starts.
import { grams, empty } from "shelf-late";

console.log(grams("rice"));
empty();
console.log(grams("rice"));
