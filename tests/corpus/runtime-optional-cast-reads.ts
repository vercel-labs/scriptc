// A runtime-optional capture (an array element of a three-arm union, read
// out of bounds or past a lying predicate) read through an ERASED wrapper:
// a cast, a `!`, or parentheses. The wrapper's own type is no arm of the
// slot, but the value at runtime is whichever arm the slot stores, so the
// read extracts the arm the identifier proves and then applies the
// wrapper's narrowing. A slot holding another arm throws a catchable
// TypeError, and an absent element throws Node's own message.

interface SessionHeader {
  type: "session";
  id: string;
  version: number;
  workspace: string;
}

interface SessionMessage {
  type: "message";
  id: string;
  timestamp: string;
}

interface SessionUsage {
  type: "usage";
  id: string;
  tokens: number;
}

type SessionEntry = SessionHeader | SessionMessage | SessionUsage;

function entries(): SessionEntry[] {
  return [
    { type: "session", id: "s1", version: 3, workspace: "/w" },
    { type: "message", id: "m1", timestamp: "t0" },
    { type: "usage", id: "u1", tokens: 12 },
  ];
}

// The census spelling: a cast on the right operand of a guard.
function headerId(all: SessionEntry[], index: number): string {
  const header = all[index];
  if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
    return "rejected";
  }
  return `${header.workspace}/${header.version}`;
}

// A `!` wrapper around the capture, then the arm read.
function bangId(all: SessionEntry[], index: number): string {
  const entry = all[index!];
  if (entry!.type !== "message") return "other";
  return entry!.timestamp;
}

// A cast naming the whole union: the value keeps its stored arm.
function castUnion(all: SessionEntry[], index: number): string {
  const entry = all[index];
  if (entry.type !== "usage") return "other";
  return `${(entry as SessionEntry).id}:${entry.tokens}`;
}

// A cast naming a field every arm of the slot declares.
function castField(all: SessionEntry[], index: number): string {
  const entry = all[index];
  if (entry.type !== "usage") return "other";
  const asIdentified = entry as { id?: unknown };
  return `${entry.id}:${typeof asIdentified.id}`;
}

const all = entries();
console.log(headerId(all, 0), headerId(all, 1), headerId(all, 2));
console.log(bangId(all, 1), bangId(all, 0), bangId(all, 2));
console.log(castUnion(all, 2), castUnion(all, 0), castUnion(all, 1));
console.log(castField(all, 2), castField(all, 0), castField(all, 1));
