// @requires-libnode
// Two deferred island packages that share no files (scope-B NI-7b): every
// static island import is deferred and none changes builtin state, so
// each package evaluates on its own first use, not when Node starts.
import { hello, NAME } from "pkg-a";
import { Counter, make } from "pkg-b";

console.log("start", NAME, typeof hello, typeof Counter, Counter.name);
console.log(hello("native"), hello("again"));
console.log("pkg-b untouched so far:", typeof make);
const c = make();
console.log(c.next(), c.next(), c instanceof Counter);
