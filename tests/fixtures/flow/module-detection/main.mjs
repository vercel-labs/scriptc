import { label } from "./noflow.js";
import { between } from "pragma-dep";

console.log(label(1, "file"), label(3, "file"));
console.log(between(1, 2, 0), between(3, 2, 1));
