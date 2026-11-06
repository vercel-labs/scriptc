// A `string | null` field written on a many-arm union of records after a
// discriminant test. The stored union has no field of that name on every arm
// (the session header arm does not), so the write lowers through the
// checker's narrowed view of the receiver instead of refusing.
interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
}

interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

interface MessageEntry extends SessionEntryBase {
  type: "message";
  message: string;
}
interface ThinkingEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}
interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId?: string;
}
interface LabelEntry extends SessionEntryBase {
  type: "label";
  label: string;
}

type SessionEntry = MessageEntry | ThinkingEntry | CompactionEntry | LabelEntry;
type FileEntry = SessionHeader | SessionEntry;

function migrate(entries: FileEntry[]): void {
  const used = new Set<string>();
  let prevId: string | null = null;
  for (const entry of entries) {
    if (entry.type === "session") {
      entry.version = 2;
      continue;
    }
    let id = `id-${used.size}`;
    while (used.has(id)) id = `${id}!`;
    used.add(id);
    entry.id = id;
    entry.parentId = prevId;
    prevId = entry.id;
  }
}

const entries: FileEntry[] = [
  { type: "session", id: "s", timestamp: "t0", cwd: "/tmp" },
  { type: "message", id: "", parentId: null, timestamp: "t1", message: "hi" },
  { type: "thinking_level_change", id: "", parentId: null, timestamp: "t2", thinkingLevel: "high" },
  { type: "compaction", id: "", parentId: null, timestamp: "t3", summary: "s" },
  { type: "label", id: "", parentId: null, timestamp: "t4", label: "l" },
];
migrate(entries);
console.log(JSON.stringify(entries));
