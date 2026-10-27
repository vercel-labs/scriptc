// The first cycle member to run calls a function of the other member
// before that member declared the constant the function reads: Node's
// temporal-dead-zone ReferenceError. A second function of the same member
// reads another constant but runs only after the cycle finished.
import { late, report } from "./alpha.ts";

console.log(report(), late());
