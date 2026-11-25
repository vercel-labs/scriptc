// `.filter` with a type predicate whose target declares fields the receiver
// element type has no slot for, on an element that also carries a member the
// target does not declare (`toolCallId`). A member the element lacks has no
// slot to copy, and the checked widening — the live-capsule check a
// predicate's claim admits — covers only an element whose own fields the
// target declares with equal types; this element is a different message
// variant, not a narrower one, so the narrowing stays refused: declare the
// wider element type at the receiver, or narrow the elements one property at
// a time.
interface SystemMessage {
  role: string;
  content: string;
  timestamp: number;
}
type TranscriptMessages = readonly { role: string; toolCallId?: string }[];

function isSystemMessage(message: { role: string }): message is SystemMessage {
  return message.role === "system";
}

const messages: TranscriptMessages = [{ role: "system" }, { role: "user", toolCallId: "t1" }];
// A guard function passed as a value.
console.log(messages.filter(isSystemMessage).length);
// The same narrowing written inline.
console.log(messages.filter((m: { role: string }): m is SystemMessage => m.role === "system").length);
