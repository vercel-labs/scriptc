/* The global Buffer under @types/node: the constructor the declaration set
 * supplies is the native class, so its statics, its instances and the
 * inspect rendering match Node's. */
import { inspect } from "node:util";

const made = Buffer.from("héllo");
console.log(Buffer.name, Buffer.length, made.length, made.toString("hex"));
console.log(Buffer.isBuffer(made), Buffer.alloc(2, 65).toString(), made instanceof Buffer);
console.log(Buffer.byteLength("héllo"), Buffer.compare(Buffer.from("a"), Buffer.from("b")));
console.log(Buffer.concat([Buffer.from("ab"), Buffer.from("cd")], 3).toString());
console.log(inspect(made), String(made.toJSON()));
console.log(made.subarray(1).toString(), made.slice(0, 2).toString("hex"), made[1]);

const alias = Buffer;
console.log(alias.from("z").toString(), alias.isBuffer(made), alias.allocUnsafe(2).length);
