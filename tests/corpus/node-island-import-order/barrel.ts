// The island re-export comes first, so the island module evaluates before
// the native module this barrel imports next.
export { tag } from "sidekit";
import { a } from "./native-a.ts";
console.log("barrel evaluates", a);
