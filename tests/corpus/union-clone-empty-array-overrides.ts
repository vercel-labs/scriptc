// Spreading a union of records and overriding a shared field with an empty
// array literal keeps each value's own variant: the `[]` (typed `never[]`)
// becomes an empty array of the selected arm's element type, also when that
// arm's field is a union with one array arm (`string | Part[]`).

interface TextPart {
  type: "text";
  text: string;
}
interface ImagePart {
  type: "image";
  data: string;
}
interface UserEntry {
  role: "user";
  content: string | (TextPart | ImagePart)[];
  timestamp: number;
}
interface AssistantEntry {
  role: "assistant";
  content: TextPart[];
  model: string;
  timestamp: number;
}
interface ToolEntry {
  role: "tool";
  toolCallId: string;
  content: (TextPart | ImagePart)[];
  isError: boolean;
  timestamp: number;
}
interface SystemEntry {
  role: "system";
  content: string;
  timestamp: number;
}
interface NoteEntry {
  role: "note";
  text: string;
  timestamp: number;
}
type Entry = UserEntry | AssistantEntry | ToolEntry | SystemEntry | NoteEntry;

function repair(entry: Entry, clear: boolean): Entry[] {
  if (entry.role === "system" && clear) return [{ ...entry, content: "" }];
  if ((entry.role === "user" || entry.role === "assistant" || entry.role === "tool") && clear) {
    return [{ ...entry, content: [] }];
  }
  return [entry];
}

interface Circle {
  kind: "circle";
  tags: string[];
  radius: number;
}
interface Square {
  kind: "square";
  tags: string[];
  side: number;
}
type Shape = Circle | Square;

function cleared(shape: Shape): Shape {
  return { ...shape, tags: [] };
}

const entries: Entry[] = [
  { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
  { role: "assistant", content: [{ type: "text", text: "hi" }], model: "m", timestamp: 2 },
  { role: "tool", toolCallId: "t1", content: [{ type: "image", data: "AA==" }], isError: false, timestamp: 3 },
  { role: "note", text: "hi", timestamp: 4 },
  { role: "system", content: "be brief", timestamp: 5 },
  { role: "user", content: "kept", timestamp: 6 },
];
entries.forEach((entry, index) => {
  for (const fixed of repair(entry, index % 2 === 0 || entry.role === "system")) {
    console.log(fixed.role, JSON.stringify(fixed), fixed === entry);
  }
});
console.log(JSON.stringify(entries[0]));

const shapes: Shape[] = [
  { kind: "circle", tags: ["round", "red"], radius: 2 },
  { kind: "square", tags: ["blue"], side: 3 },
];
for (const shape of shapes) {
  const copy = cleared(shape);
  copy.tags.push("fresh");
  const area = copy.kind === "circle" ? copy.radius * copy.radius * 3 : copy.side * copy.side;
  console.log(copy.kind, area, copy.tags.join("+"), shape.tags.join("+"), copy !== shape);
}
