// A JavaScript package whose `var` bindings start as one type and later
// hold another, as js-yaml's timestamp and error code does: a number that
// becomes a string and back (`fraction = match[7].slice(0, 3)`), an object
// literal that gains a member (`mark.snippet = snippet(mark)`), and `+=` of
// a string onto a number. Node runs every write; each binding holds it.
import { errorAt, millis, label, total } from "scalar-marks";

console.log(millis("2001-12-14t21:59:43.10"), millis("2001-12-14t21:59:43"), millis("1970-01-01t00:00:00.12345"));
for (const [input, at] of [["a: [1", 5], ["key: 'open", 10], ["a:\n  [1", 7], ["ok", 1]] as const) {
  try {
    console.log(errorAt(input, at, "unexpected end"));
  } catch (e) {
    const err = e as { name: string; message: string; mark: { line: number; column: number; snippet: string } };
    console.log(err.name, "|", err.message, "|", err.mark.line, err.mark.column, JSON.stringify(err.mark.snippet));
  }
}
console.log(label(3), label(0));
console.log(total([1, 2, 3]), total(["a", "b"]), total([1, "b", 2]));
