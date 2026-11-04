// `.filter` with a type predicate whose target declares fields the receiver
// element type has no slot for. The elements were narrowed when they were
// STORED (`const messages: { role: string }[] = [wider, ...]` copies each
// wider object into the element's layout), so `content`/`timestamp` no
// longer exist at runtime: the predicate cannot make them real, and trusting
// it would hand out a value whose fields are missing. Node would answer
// `undefined` reads here; that is the record-layout divergence the refusal
// keeps out of reach — declare the wider element type at the receiver.
interface SystemMessage {
  role: "system";
  content: string;
  timestamp: number;
}
type TranscriptMessages = readonly { role: string }[];

function isSystemMessage(message: { role: string }): message is SystemMessage {
  return message.role === "system";
}

const first = { role: "system", content: "base", timestamp: 1 };
const second = { role: "user", content: "hi", timestamp: 2 };
const messages: TranscriptMessages = [first, second];
// A guard function passed as a value.
console.log(messages.filter(isSystemMessage).length);
// The same narrowing written inline.
console.log(messages.filter((m): m is SystemMessage => m.role === "system").length);
