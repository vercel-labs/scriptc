// crypto.randomUUID reached THROUGH a dep-style module: the npm package
// shape (dep entry imports node:crypto, program imports the dep). The
// program compiles statically — the native crypto runtime must link with
// no island — and every line prints a DERIVED assertion that holds under
// Node and the compiled binary alike (randomness is never compared
// value-wise).
import { v4, dashes } from "./uuid.ts";

const u = v4();
console.log("len", u.length === 36);
console.log("dashes", dashes(u) === "----");
console.log("version", u.charAt(14) === "4");
console.log("variant", "89ab".includes(u.charAt(19)));
console.log("lowercase-hex", /^[0-9a-f-]+$/.test(u));
console.log("fresh", v4() !== u);
