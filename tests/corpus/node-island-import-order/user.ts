// A native import, then an island import, then another native import.
import { b } from "./native-b.ts";
import { tag } from "laterkit";
import { a } from "./native-a.ts";
console.log("user evaluates", tag(a + b));
