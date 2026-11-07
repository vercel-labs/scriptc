// Object.assign onto a UNION-typed element — the provider event converter's
// `Object.assign(partial.content[event.contentIndex]!, { text, textSignature })`
// — asks a per-ARM question: the arm that declares the source's keys writes
// them in place, and an arm that does not grows through its kept source.
// The write mutates the element the array holds, so a reference kept from an
// earlier event sees it, exactly as Node's one object does.
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

const parts: ContentPart[] = [
  { type: "text", text: "" },
  { type: "thinking", thinking: "" },
];
const held = parts[0]!;
applyTextEnd(parts, 0, "hi", "sig");
if (held.type === "text")
  console.log("held:", held === parts[0], Object.keys(held).join(","), held.textSignature);
// The thinking arm does not declare the source's keys, so it grows.
applyTextEnd(parts, 1, "hi again", "sig2");
const grown = parts[1]!;
if (grown.type === "thinking")
  console.log("grown:", JSON.stringify(grown), Object.keys(grown).join(","), "text" in grown);
