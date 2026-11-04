// An object literal carrying an asserted type (`{ ...message, content } as
// Message`) whose union-valued member holds an arm the asserted target
// excludes: the member converts in a CHECKED context, so the excluded arm
// re-tags to the catchable TypeError the lying-assertion stance promises
// instead of refusing the whole literal. Node erases the assertion and the
// object flows on, so the printing cases below pin the matching shapes.
type ToolArgs = { arguments: unknown; id: string; name: string; type: string };
type Mime = { data: string; mimeType: string; type: string };
type Text = { text: string; textSignature?: string; type: string };
type Content = ToolArgs[] | (Mime | Text)[] | string;
type Replacement = { content: Content };
type Message = { role: string; content: (Mime | Text)[] | string };

function rewritten(message: Message, replacement: Replacement): Message {
  const content =
    typeof replacement.content === "string"
      ? [{ type: "text" as const, text: replacement.content }]
      : replacement.content;
  return { ...message, content } as Message;
}

function replaced(message: Message, content: (Mime | Text)[]): Message {
  return { ...message, content } as Message;
}

// Parentheses around the literal name the same operand.
function parenthesized(message: Message, content: (Mime | Text)[]): Message {
  return ({ ...message, content }) as Message;
}

const text: Text = { type: "text", text: "hello" };
const mime: Mime = { type: "image", mimeType: "image/png", data: "AAAA" };

console.log(JSON.stringify(rewritten({ role: "user", content: "" }, { content: "bye" })));
const kept = replaced({ role: "user", content: [text] }, [text, mime]);
console.log(JSON.stringify(kept));
console.log(kept.role, Array.isArray(kept.content) ? kept.content.length : "string");
console.log(JSON.stringify(replaced({ role: "assistant", content: "plain" }, [mime])));
console.log(JSON.stringify(parenthesized({ role: "user", content: [text] }, [mime])));
