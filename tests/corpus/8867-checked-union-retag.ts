// A user type predicate inside a ternary (`first && isSystemMessage(first)
// ? first : undefined`) narrows a `{ role: string } | undefined` binding to
// the wider SystemMessage, so the expression is a union conversion of two
// arms that have no identical destination layout: the record arm enters the
// destination arm through the checked widening (a live capsule checked
// against the arm), the undefined arm keeps its own copy. The widened value
// reads the properties the source kept beside its narrowed fields, exactly
// as the stored object carries them.
interface SystemMessage {
  role: string;
  content: string;
  timestamp: number;
  toolsAdded?: { name: string }[];
}
type StoredMessage =
  | { role: string; content: string; timestamp: number; toolsAdded?: { name: string }[] }
  | { role: string; toolCallId: string };

function isSystemMessage(message: { role: string }): message is SystemMessage {
  return message.role === "system";
}
function firstSystem(messages: { role: string }[]): SystemMessage | undefined {
  const first: { role: string } | undefined = messages[0];
  return first && isSystemMessage(first) ? first : undefined;
}

const stored: StoredMessage[] = [
  { role: "system", content: "hello", timestamp: 1 },
  { role: "user", toolCallId: "t1" },
  {
    role: "system",
    content: "again",
    timestamp: 2,
    toolsAdded: [{ name: "read" }],
  },
];
// Storing into the narrower element layout keeps each object's other
// properties beside the copy, so the widening can read them.
const narrowed: { role: string }[] = stored;
for (let index = 0; index < 4; index++) {
  const first = firstSystem(narrowed.slice(index));
  console.log(
    index,
    first === undefined ? "none" : `${first.timestamp}:${first.content}`,
    first === undefined ? "" : JSON.stringify(first),
    first === undefined ? "" : Object.keys(first).join(","),
  );
}

// The same conversion reached through a declared narrow union, not a binding
// read, and the widened value keeps working as a SystemMessage.
type Narrow = { role: string } | undefined;
function pick(source: Narrow): SystemMessage | undefined {
  return source && isSystemMessage(source) ? source : undefined;
}
const picked = pick(narrowed[2]);
console.log(picked ? `${picked.role} ${picked.toolsAdded?.length ?? 0}` : "none");
console.log(pick(undefined) === undefined ? "unit" : "some");
