// A record that reached its declared type through a conversion (an array
// literal returned by a generic helper, whose elements the checker types by
// the literal) and is then written: Object.assign copies every own field of
// its source, including one typed by an index signature and an explicit
// undefined, and later writes to those fields and to the nested object are
// what JSON.stringify, Object.keys, Object.entries and console.log show.
function through<T>(value: T): T {
  return value;
}
interface Options {
  [key: string]: string;
}
interface Call {
  kind: "call";
  id: string;
  name: string;
  options: Options;
  note?: string;
}
interface Text {
  kind: "text";
  text: string;
}
type Part = Text | Call;
interface Message {
  parts: Part[];
}

const messages: Message[] = through([
  {
    parts: [
      { kind: "call", id: "a", name: "first", options: { k: "v" }, note: "keep" },
      { kind: "text", text: "hello" },
    ],
  },
]);
const source: Call = { kind: "call", id: "a2", name: "third", options: { k: "v2" } };
const element = messages[0]?.parts[0];
if (element?.kind === "call") {
  const returned = Object.assign(element, source);
  console.log(JSON.stringify(element), returned === element);
  console.log(Object.keys(element).join(","));

  element.options.k = "changed";
  element.options.extra = "new";
  console.log(JSON.stringify(element));

  const explicit: Call = { kind: "call", id: "a3", name: "fourth", options: {}, note: undefined };
  Object.assign(element, explicit);
  console.log(JSON.stringify(element), Object.keys(element).join(","), "note" in element);

  element.options = { z: "1" };
  element.note = "again";
  console.log(JSON.stringify(element));
  console.log(element);
  console.log(Object.entries(element).length, Object.values(element).length);
}
console.log(JSON.stringify(messages));

// The same conversion with no write afterwards still shows the literal's
// values.
const untouched: Message[] = through([
  { parts: [{ kind: "call", id: "u", name: "plain", options: { a: "1", b: "2" } }] },
]);
const first = untouched[0]?.parts[0];
if (first?.kind === "call") console.log(JSON.stringify(untouched), Object.keys(first).join(","));
