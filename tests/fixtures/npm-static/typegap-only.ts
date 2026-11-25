// typegap-mix.ts without its compiled package: the untyped package alone.
// Both programs report its import the same way.
import label from "typegapped";

console.log(label(3));
