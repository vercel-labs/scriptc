// A fresh array-literal arm of a conditional whose checker join is a union of
// array layouts is built at the union, where the fresh-literal rule picks the
// complete arm. Coercing the bare literal into the union refused because two
// array arms fit it (pi's session edit rewriting a message's content).
interface ArgumentsBlock {
	arguments: unknown;
	id: string;
	type: "tool_use";
}

interface RedactedBlock {
	redacted: boolean | undefined;
	thinking: string;
	type: "redacted";
}

interface TextBlock {
	signature?: string;
	text: string;
	type: "text";
}

interface ImageBlock {
	data: string;
	type: "image";
}

type Block = ArgumentsBlock | RedactedBlock | TextBlock;
type Content = Block[] | (ImageBlock | TextBlock)[] | string;

interface Message {
	content: Content;
	role: string;
	timestamp: number;
}

interface Replacement {
	content: Content | string;
}

function patch(message: Message, replacement: Replacement): Message {
	const content =
		(message.role === "assistant" || message.role === "toolResult") &&
		typeof replacement.content === "string"
			? [{ text: replacement.content, type: "text" as const }]
			: replacement.content;
	return { ...message, content } as Message;
}

function preview(content: Content): string {
	if (typeof content === "string") return `text:${content}`;
	return content
		.map((block) => {
			switch (block.type) {
				case "text":
					return `text:${block.text}`;
				case "image":
					return `image:${block.data}`;
				case "tool_use":
					return `tool:${block.id}`;
				case "redacted":
					return `redacted:${block.thinking}`;
				default:
					return "other";
			}
		})
		.join(",");
}

const assistant: Message = {
	content: [
		{ arguments: {}, id: "call-1", type: "tool_use" },
		{ signature: "sig", text: "before", type: "text" },
	],
	role: "assistant",
	timestamp: 7,
};
const patched = patch(assistant, { content: "after" });
console.log(patched.role, patched.timestamp, preview(patched.content));

const kept = patch(assistant, { content: assistant.content });
console.log(kept.role, preview(kept.content));

const user: Message = { content: "hello", role: "user", timestamp: 8 };
console.log(preview(patch(user, { content: "ignored" }).content));

const images: Message = { content: [{ data: "img", type: "image" }], role: "assistant", timestamp: 9 };
console.log(preview(patch(images, { content: "replaced" }).content));
