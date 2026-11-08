// The text of a built-in constructor held as a value is Node's
// `function String() { [native code] }` in every string conversion, whether
// the value sits in a typed slot or in an untyped one.
import { format } from "node:util";

type Reader = typeof String | typeof Number | typeof Boolean;
function pick(reader: Reader): Reader {
  return reader;
}
const one = String;
const some = pick(Number);
const shelf: Record<string, Reader> = { title: String, lent: Boolean };
const loose: unknown = shelf;

console.log(String(one));
console.log(`${one}`, one + "");
console.log(one.toString());
console.log(String(some), some.toString());
console.log(String(shelf.lent), `${shelf.title}`, shelf.lent + "!");
console.log(format("%s", shelf.title), format("%s|%s", one, some));
console.log("%s", shelf.lent);
console.log(typeof loose, String(shelf.title).length);
