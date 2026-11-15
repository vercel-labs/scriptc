// @requires-libnode
// Two entries of one island package share a module with state: it loads
// once (its load prints), and a class and an object it declares are the
// same through both entries.
import { add, make } from "twoentry/counter";
import { isToken, total, valueOf } from "twoentry/reader";

console.log("start", total());
console.log(add(2), add(5), total());
const token = make();
console.log(isToken(token), valueOf(token));
