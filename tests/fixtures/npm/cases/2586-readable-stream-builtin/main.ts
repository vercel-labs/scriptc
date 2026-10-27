// readable-stream 2.x and 4.x compile as Node's builtin stream module:
// the package's own READABLE_STREAM=disable behavior. The Node side of this
// case runs with READABLE_STREAM=disable; without it Node runs the
// package's JavaScript streams, whose output can differ.
import { kinds, shout } from "gtrs2";
import { count } from "gtrs4";

console.log(kinds());
shout(["a", "bc", "def"], (result) => console.log("2.x", result));
count(["one", "two", "three"], (total) => console.log("4.x", total));
