// The first cycle member to run builds classes whose static initializers
// call a method through `this`, directly and from an arrow function; both
// methods read constants of the other member before it declared them:
// Node's temporal-dead-zone ReferenceError. A third method reads a constant
// only after the cycle finished.
import { label, Probe, later } from "./alpha.ts";

console.log(label, Probe.result, later());
