// The provider event converter's Object.assign onto an element of a
// union-typed array (pi-messages.ts:237/249/271): the arm is known only at
// run time, so the write switches on the element's tag and mutates that
// arm's own record — a reference held from an earlier delta event sees it.
// An arm that does not declare the source's keys grows through its kept
// source, so the element gains the key exactly as Node's one object does.
interface Text {
  type: "text";
  text: string;
  textSignature?: string;
}
interface Thinking {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}
interface Call {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}
interface Image {
  type: "image";
  data: string;
}
interface Msg {
  content: (Text | Thinking | Call)[];
}

type Ev =
  | { type: "text_start"; i: number }
  | { type: "text_end"; i: number; content: string; signature?: string }
  | { type: "thinking_end"; i: number; content: string; signature?: string; redacted?: boolean }
  | { type: "call_end"; i: number; call: Call };

function apply(m: Msg, e: Ev): void {
  switch (e.type) {
    case "text_start":
      m.content[e.i] = { type: "text", text: "" };
      break;
    case "text_end":
      Object.assign(m.content[e.i]!, { text: e.content, textSignature: e.signature });
      break;
    case "thinking_end":
      Object.assign(m.content[e.i]!, {
        thinking: e.content,
        thinkingSignature: e.signature,
        redacted: e.redacted,
      });
      break;
    case "call_end":
      Object.assign(m.content[e.i]!, e.call);
      break;
  }
}

const m: Msg = { content: [] };
apply(m, { type: "text_start", i: 0 });
const held = m.content[0]!; // an alias of the element taken before the assign
apply(m, { type: "text_end", i: 0, content: "hello" });
// `redacted` is set at creation: the per-field copy of a covering arm writes
// a declared key the element does not carry yet in the shape's canonical slot
// order, so a source that adds two such keys at once interleaves them where
// Node appends them in the source's order — a separate key-order gap, not
// this write's identity or growth question.
m.content[1] = { type: "thinking", thinking: "", redacted: false };
apply(m, { type: "thinking_end", i: 1, content: "hmm", signature: "sig", redacted: false });
m.content[2] = { type: "toolCall", id: "c1", name: "ls", arguments: {} };
apply(m, {
  type: "call_end",
  i: 2,
  call: { type: "toolCall", id: "c1", name: "ls", arguments: { a: 1 }, thoughtSignature: "t" },
});
console.log("message:", JSON.stringify(m));
console.log("held:", held === m.content[0], JSON.stringify(held));
const text = m.content[0]!;
if (text.type === "text")
  console.log("text keys:", Object.keys(text).join(","), text.textSignature);
const thinking = m.content[1]!;
if (thinking.type === "thinking")
  console.log("thinking keys:", Object.keys(thinking).join(","), thinking.redacted);

// The runtime arm does not declare the source's key, so the element grows.
const parts: (Text | Image)[] = [{ type: "image", data: "x" }];
const partHeld = parts[0]!;
Object.assign(parts[0]!, { text: "added" });
const grown = parts[0]!;
if (grown.type === "image")
  console.log("grown arm:", JSON.stringify(grown), Object.keys(grown).join(","), "text" in grown);
console.log("grown alias:", partHeld === parts[0], JSON.stringify(partHeld));

// A re-assigned added key keeps its position.
Object.assign(parts[0]!, { text: "again" });
if (grown.type === "image")
  console.log("reassigned:", JSON.stringify(grown), Object.keys(grown).join(","));
