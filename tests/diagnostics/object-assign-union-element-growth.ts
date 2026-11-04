// Object.assign onto a UNION-typed element — the provider event converter's
// `Object.assign(partial.content[event.contentIndex]!, { text, textSignature })`
// — asks a per-ARM question, and the answer differs by arm. Node copies the
// source's own enumerable keys onto whatever the value is: on the arm that
// declares those keys it is an ordinary write, and on an arm that does not it
// is growth (the object gains a key its type has none of). A fixed record
// cannot grow, the element's static type does not say which arm the runtime
// value is, and dispatch on the tag would have to grow the arms that lack the
// keys. The refusal stands by name rather than copying through one arm's
// layout; write the field on the arm you know, or build the element with the
// keys it needs.
interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}
interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
}

type ContentPart = TextContent | ThinkingContent;

function applyTextEnd(parts: ContentPart[], index: number, text: string, signature: string): void {
  Object.assign(parts[index]!, { text, textSignature: signature });
  console.log(JSON.stringify(parts));
}

applyTextEnd([{ type: "text", text: "" }], 0, "hi", "sig");
