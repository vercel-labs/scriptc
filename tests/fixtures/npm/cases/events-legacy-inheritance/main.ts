// @dynamic
// Packages that inherit from EventEmitter the pre-class way — calling the
// constructor on their own instance, as ioredis does — run in the island
// exactly as under Node.
import { report } from "emitterzoo";

console.log(report());
