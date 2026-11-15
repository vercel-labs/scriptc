// A compound assignment through a type assertion on a union element
// (`(parts[i] as { text: string }).text += delta`): Node erases the
// assertion and appends to the member of the object the element holds.
// The one arm whose layout carries the member at the asserted type is the
// write target.
type Text = { type: "text"; text: string };
type Thinking = { type: "thinking"; thinking: string };
type Tool = { type: "tool"; id: string };
type Part = Text | Thinking | Tool;

const parts: Part[] = [
  { type: "text", text: "a" },
  { type: "thinking", thinking: "t" },
  { type: "tool", id: "1" },
];
const index = 0;
(parts[index] as { text: string }).text += "!";
(parts[index + 1] as { thinking: string }).thinking += "?";
(parts[index + 2] as { id: string }).id += "#";
console.log(JSON.stringify(parts));

function append(part: Part, delta: string): Part {
  if (part.type === "text") (part as { text: string }).text += delta;
  if (part.type === "tool") (part as { id: string }).id = (part as { id: string }).id + delta;
  return part;
}
console.log(JSON.stringify(append({ type: "text", text: "x" }, "-text")));
console.log(JSON.stringify(append({ type: "tool", id: "t" }, "-id")));
