// A written predicate narrowing elements to a record that declares required
// members the element type lacks (`{ role: string }` into a system message
// whose `content` and `timestamp` are required): the checked widening reads
// the properties the narrowed value kept beside its declared fields, and a
// value that genuinely lacks one throws the catchable TypeError.
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
function stamp(message: SystemMessage): string {
  return `${message.timestamp}:${message.content}`;
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
const systems = narrowed.filter(isSystemMessage);
console.log(systems.length, systems.map(stamp).join("|"));
for (const message of systems) {
  console.log(message.role, message.content, message.timestamp, JSON.stringify(message));
}
console.log(JSON.stringify(narrowed), Object.keys(narrowed[0] ?? {}).join(","));

// A property the target type does not declare stays visible through the
// widening: JSON and keys answer with the source's own properties.
interface Tagged {
  role: string;
  content: string;
  timestamp: number;
  toolCallId: string;
}
const tagged: Tagged[] = [
  { role: "system", content: "tagged", timestamp: 3, toolCallId: "t9" },
];
const taggedNarrow: { role: string }[] = tagged;
for (const message of taggedNarrow.filter(isSystemMessage)) {
  console.log(JSON.stringify(message), Object.keys(message).join(","));
}

// A source value both arms hold exactly keeps its own copy (the field-copy
// plan wins over the checked widening).
const plain: { role: string } = { role: "system" };
console.log(JSON.stringify(plain), isSystemMessage(plain) ? plain.role : "no");
