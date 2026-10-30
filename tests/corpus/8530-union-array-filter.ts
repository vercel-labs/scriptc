// `.filter` on a UNION OF ARRAYS (`A[] | B[]`, TS 5.2's callable-union
// rule): the predicate runs over `A | B`, and the checker's result element
// is the one the predicate names — not any arm's own element. The runtime
// value is one concrete arm's array, so the filter dispatches on that arm,
// keeps the arm's survivors in order, and converts each survivor to the
// named element.
interface TextContent {
  type: "text";
  text: string;
}
interface ImageContent {
  type: "image";
  data: string;
}
interface ThinkingContent {
  type: "thinking";
  thinking: string;
}
interface ToolCall {
  type: "tool";
  name: string;
}
type MessageContent =
  | TextContent[]
  | (ImageContent | TextContent)[]
  | (ThinkingContent | ToolCall | TextContent)[];

function textOf(content: MessageContent): string {
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join(" ");
}

const contents: MessageContent[] = [
  [{ type: "text", text: "a" }, { type: "text", text: "b" }],
  [
    { type: "image", data: "AA" },
    { type: "text", text: "c" },
  ],
  [
    { type: "thinking", thinking: "t" },
    { type: "tool", name: "n" },
    { type: "text", text: "d" },
  ],
];
for (const content of contents) console.log("text", textOf(content));

// A predicate written as a function EXPRESSION rather than an arrow: the
// same receiver, the same per-arm dispatch.
function expressions(content: MessageContent): string {
  return content
    .filter(function (block): block is TextContent {
      return block.type === "text";
    })
    .map((block) => block.text)
    .join(" ");
}
console.log("expr", expressions(contents[1]!), expressions(contents[2]!));

// The predicate sees the union-wide element, so an arm-specific test is
// legal; the survivors still convert per arm.
function longTexts(content: MessageContent): string[] {
  return content
    .filter((block): block is TextContent => block.type === "text" && block.text !== "c")
    .map((block) => block.text);
}
console.log("long", longTexts(contents[1]!).join("+"), longTexts(contents[2]!).join("+"));

// Node's `filter` reads the length once and visits elements in order; the
// arm dispatch must not change either, and the result is a fresh array.
let seen = 0;
function counted(content: MessageContent): number {
  const kept = content.filter((block): block is TextContent => {
    seen++;
    return block.type === "text";
  });
  return kept.length;
}
console.log("counted", counted(contents[2]!), "seen", seen);
// The empty array is spelled with its arm's type: a bare `[]` literal
// assigned to this three-arm array union is a separate, unrelated gap (the
// literal's `number[]` element has no arm conversion), so it would obscure
// what this program pins.
const empty: MessageContent = [] as TextContent[];
console.log("empty", textOf(empty), counted(empty), "seen", seen);
