// `unsafe<T>` declares the caller's own type and hands back the value it
// was given: the declared type is a checked-identity view, so the value —
// the `structuredClone` copy here — keeps its identity and every read checks
// the declared type. A field that contradicts the declaration throws a
// TypeError at the read instead of handing native code the wrong value (a
// corpus program cannot pin this: Node prints the field).
import { unsafe } from "recordkit";

type ColorValues = { [K in "fg" | "bg"]: string } & { [K in "accent"]?: string };

const raw: unknown = JSON.parse('{"fg":1,"bg":"blue"}');
console.log("before");
const colors = structuredClone(unsafe<ColorValues>(raw as ColorValues));
console.log("after", colors.fg);
