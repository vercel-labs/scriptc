/* A builtin module namespace boxed as a checked-dynamic value answers the
 * members that have a value lowering: util.inspect through the box is the
 * same function Node's namespace member is, so a dynamic call inspects the
 * same way. */
import * as util from "node:util";

const boxed: any = util;
console.log("typeof", typeof boxed.inspect, "in", "inspect" in boxed);
console.log("call", boxed.inspect({ a: 1, b: [2, 3] }));
console.log("same", boxed.inspect === util.inspect);
