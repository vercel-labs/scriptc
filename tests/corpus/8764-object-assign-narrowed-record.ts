// Object.assign(record, record) where an operand's lowered value is a
// UNION the checker narrowed to one record arm — the pi proxy's
// `Object.assign(content, proxyEvent.toolCall)` after
// `content?.type === "toolCall"`. The write mutates the value the program
// holds (JS identity), copies a source field only when it is present, and
// answers the target. Both operand positions, a predicate's narrowing, and
// an index-signature field are pinned here.
interface Args {
  [key: string]: string;
}
interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  args: Args;
  note?: string;
}
interface TextPart {
  type: "text";
  text: string;
}
type Part = TextPart | ToolCall;

const events: Part[] = [
  { type: "toolCall", id: "a", name: "first", args: { k: "v" }, note: "keep" },
  { type: "toolCall", id: "b", name: "second", args: {} },
  { type: "text", text: "hello" },
];

// TARGET narrowed by an optional-chain discriminant, SOURCE a plain
// record whose omitted optional field must not erase the target's own.
const target = events[0]!;
const source: ToolCall = { type: "toolCall", id: "a2", name: "third", args: { k: "v2" } };
if (target?.type === "toolCall") {
  const returned = Object.assign(target, source);
  console.log("target:", JSON.stringify(events[0]));
  console.log("answers the target:", returned === target);
}

// SOURCE narrowed: an array element read typed as the union.
for (const part of events) {
  if (part.type === "toolCall") {
    const fresh: ToolCall = { type: "toolCall", id: "z", name: "z", args: {} };
    Object.assign(fresh, part);
    console.log("from source:", JSON.stringify(fresh));
  }
}

// BOTH operands narrowed through a predicate call.
function isCall(part: Part): part is ToolCall {
  return part.type === "toolCall";
}
const first = events[0]!;
const second = events[1]!;
if (isCall(first) && isCall(second)) {
  const returned = Object.assign(second, first);
  console.log("both:", JSON.stringify(second), returned === second);
}

// An explicit `undefined` is an own key in Node and copies; only an
// ABSENT source field leaves the target's value alone.
const explicit: ToolCall = { type: "toolCall", id: "e", name: "e", args: {}, note: undefined };
if (target.type === "toolCall") {
  Object.assign(target, explicit);
  console.log("explicit undefined:", JSON.stringify(events[0]));
}

// The narrowed arm survives a loop body and a re-read through the array.
for (let i = 0; i < events.length; i++) {
  const part = events[i]!;
  if (part.type !== "toolCall") continue;
  const patch: ToolCall = { type: "toolCall", id: "p", name: "patched", args: { i: "1" } };
  Object.assign(part, patch);
}
console.log("loop:", JSON.stringify(events));
