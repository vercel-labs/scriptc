// A const alias of crypto.subtle has no value: only method calls lower.
import * as crypto from "node:crypto";

const s = crypto.subtle;
console.log(typeof s);
