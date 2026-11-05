// `unsafe<T>` declares the caller's own type and hands back the value it
// was given: the record crossing out is a deep CHECKED copy, so a field
// that contradicts the declaration throws a TypeError instead of entering a
// native record (a corpus program cannot pin this: Node prints the field).
import { unsafe } from "recordkit";

type ColorValues = { [K in "fg" | "bg"]: string } & { [K in "accent"]?: string };

const raw: unknown = JSON.parse('{"fg":1,"bg":"blue"}');
console.log("before");
const colors = unsafe<ColorValues>(raw as ColorValues);
console.log("after", colors.fg);
