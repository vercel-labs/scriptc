// Object.assign(record, record) where an operand's lowered value is a
// UNION the checker narrowed to one record arm — the pi proxy's
// `Object.assign(content, proxyEvent.toolCall)` after
// `content?.type === "toolCall"`. The write mutates the value the program
// holds (JS identity), copies a source field only when it is present, and
// answers the target. Both operand positions, a predicate's narrowing, and
// an index-signature field are pinned here. Every operand is read WITHOUT a
// non-null assertion, so the lowered value still carries the declared union
// and the call reaches the narrowed-arm path rather than a record-typed
// local.
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
interface Message {
  content: Part[];
}

const messages: Message[] = [
  {
    content: [
      { type: "toolCall", id: "a", name: "first", args: { k: "v" }, note: "keep" },
      { type: "text", text: "hello" },
    ],
  },
  { content: [{ type: "toolCall", id: "b", name: "second", args: {} }] },
];

// TARGET narrowed by an optional-chain discriminant. The source omits its
// optional field, so the target keeps its own.
const source: ToolCall = { type: "toolCall", id: "a2", name: "third", args: { k: "v2" } };
const element = messages[0]?.content[0];
if (element?.type === "toolCall") {
  const returned = Object.assign(element, source);
  console.log("target:", JSON.stringify(element));
  console.log("answers the target:", returned === element);
}
console.log("same value in the array:", JSON.stringify(messages[0]?.content[0]));

// SOURCE narrowed: an array element read typed as the union.
for (const part of messages[1]!.content) {
  if (part.type === "toolCall") {
    const fresh: ToolCall = { type: "toolCall", id: "z", name: "z", args: {} };
    Object.assign(fresh, part);
    console.log("from source:", JSON.stringify(fresh));
  }
}

// BOTH operands narrowed through a predicate call.
function isCall(part: Part | undefined): part is ToolCall {
  return part !== undefined && part.type === "toolCall";
}
const first = messages[0]?.content[0];
const second = messages[0]?.content[1];
if (isCall(first) && !isCall(second)) console.log("predicate narrowed the second:", second.type);
if (isCall(first)) {
  const patch: ToolCall = { type: "toolCall", id: "p0", name: "patched", args: {} };
  const returned = Object.assign(first, patch);
  console.log("both:", JSON.stringify(first), returned === first);
}

// An explicit `undefined` is an own key in Node and copies; only an
// ABSENT source field leaves the target's value alone.
const explicit: ToolCall = { type: "toolCall", id: "e", name: "e", args: {}, note: undefined };
const third = messages[0]?.content[0];
if (isCall(third)) {
  Object.assign(third, explicit);
  console.log("explicit undefined:", JSON.stringify(third));
}

// The narrowed arm survives a loop body and a re-read through the array.
for (let i = 0; i < messages.length; i += 1) {
  const part = messages[i]?.content[0];
  if (part?.type !== "toolCall") continue;
  const patch: ToolCall = { type: "toolCall", id: "loop", name: "looped", args: { i: String(i) } };
  Object.assign(part, patch);
}
console.log("loop:", JSON.stringify(messages));
