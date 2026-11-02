// A program that observes a file read's Buffer-ness only through function
// values crossing the unknown boundary: a typed reader boxed into `any`
// and called dynamically, and an untyped consumer checked to a function
// type that typed code calls with the bytes. Both see a Buffer, as in Node.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);

function load(): Buffer {
  return readFileSync(self);
}
const reader: any = load;
const viaReader = reader();
console.log("boxed reader", Buffer.isBuffer(viaReader), viaReader.length > 0);

const untyped: any = (value: unknown) => {
  console.log("checked consumer", Buffer.isBuffer(value), (value as Uint8Array).length > 0);
};
const consume = untyped as (bytes: Buffer) => void;
consume(readFileSync(self));
