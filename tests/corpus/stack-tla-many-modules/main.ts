// A top-level-await module's initialization runs on an async fiber, and that
// prefix evaluates the whole synchronous import graph: a large program's module
// initialization nests constructors and generated class helpers hundreds of
// KiB deep. The fiber therefore needs the process's stack budget. The
// nine-module chain below reaches leaf.ts, whose 300 recursive frames (200
// locals each) exceed the 512 KiB fiber this shipped with, while Node and a
// main-thread initialization accept them.
import { down } from "./chain0.ts";

const value = down(300);
await Promise.resolve();
console.log("ok", value);
