// Object spreads whose source is a union of records: TypeScript types
// `{ ...u, k: v }` as one spread per arm of `u`, and the literal is built
// that way. The running arm decides which destination arm holds the result:
// the discriminant's last writer, else the source arm itself, else the one
// arm with exactly the written keys. JSON.stringify pins key order too.

// 1. One union source plus an override, inside an array callback, after a
//    discriminant test narrowed the stored union.
type Text = { type: "text"; text: string };
type Image = { type: "image"; data: string };
type UserMsg = { role: "user"; content: string | (Text | Image)[]; ts: number };
type AsstMsg = { role: "assistant"; content: Text[]; model: string };
type ToolMsg = { role: "tool"; content: (Text | Image)[]; toolId: string; isError?: boolean };
type Msg = UserMsg | AsstMsg | ToolMsg;

function stripImages(msgs: Msg[]): Msg[] {
  return msgs.map((msg) => {
    if (msg.role === "user" || msg.role === "tool") {
      const content = msg.content;
      if (Array.isArray(content)) {
        const filtered = content.map((c) =>
          c.type === "image" ? { type: "text" as const, text: "[image]" } : c,
        );
        return { ...msg, content: filtered };
      }
    }
    return msg;
  });
}

// 2. A union source plus a field the arms declare optional, cast back.
type Cmd =
  | { id?: string; type: "prompt"; message: string }
  | { id?: string; type: "abort" }
  | { id?: string; type: "set_model"; provider: string; modelId: string };
let next = 0;
function withId(command: Cmd): Cmd {
  const id = `req_${++next}`;
  return { ...command, id } as Cmd;
}

// 3. An optional group `{} | { during }` spread into a discriminated result.
type Result =
  | { ok: true; value: number; during?: { seq: number } }
  | { ok: false; error: string; during?: { seq: number } };
function finish(error: string | undefined, seq: number | undefined): Result {
  const ended = seq === undefined ? {} : { during: { seq } };
  return error ? { ok: false, error, ...ended } : { ok: true, value: 1, ...ended };
}

// 4. A discriminant test leaves several arms; overrides set and clear keys.
type Ref =
  | { status: "resolved"; name: string; level?: string; warning?: string }
  | { status: "ambiguous"; names: string[]; level?: string; warning?: string }
  | { status: "not-found" };
function relevel(inner: Ref): Ref {
  if (inner.status === "not-found") return inner;
  return { ...inner, level: undefined, warning: "w" };
}

// 5. The source supplies the second half of an event whose discriminant
//    value is shared by two arms; the written keys pick the arm.
type Ev =
  | { type: "start" }
  | { type: "retry"; source: "branch" }
  | { type: "retry"; source: "compact"; reason: "manual" | "auto" }
  | { type: "end"; count: number };
const events: string[] = [];
function emit(event: Ev): void {
  events.push(JSON.stringify(event));
}
function retrying(source: { source: "branch" } | { source: "compact"; reason: "manual" | "auto" }) {
  emit({ type: "retry", ...source });
}

// 6. A cast-built event from a union base.
type BaseA = { type: "settle"; id: string };
type BaseB = { type: "turn"; id: string; turn: number };
type SettleEv = BaseA & { entries: string[]; more: boolean };
type TurnEv = BaseB & { entries: string[]; more: boolean };
function boundary(base: BaseA | BaseB, entries: string[]): SettleEv | TurnEv {
  return { ...base, entries, more: entries.length > 1 } as SettleEv | TurnEv;
}

// 7. A message update whose override's type differs per arm.
type Part = { type: "text"; text: string };
type UMsg = { role: "user"; content: string | Part[] };
type AMsg = { role: "assistant"; content: Part[]; model: string };
type Note = { role: "note"; body: string };
type AnyMsg = UMsg | AMsg | Note;
function replace(messages: AnyMsg[], text: string): AnyMsg[] {
  return messages.map((message) => {
    if (message.role !== "user" && message.role !== "assistant") return message;
    const content = message.role === "assistant" ? [{ type: "text" as const, text }] : text;
    return { ...message, content } as AnyMsg;
  });
}

const msgs: Msg[] = [
  { role: "user", content: [{ type: "image", data: "x" }, { type: "text", text: "hi" }], ts: 1 },
  { role: "assistant", content: [{ type: "text", text: "ok" }], model: "m" },
  { role: "tool", content: [{ type: "image", data: "y" }], toolId: "t1", isError: false },
  { role: "user", content: "plain", ts: 2 },
];
for (const m of stripImages(msgs)) console.log(JSON.stringify(m));
console.log(JSON.stringify(withId({ type: "prompt", message: "go" })));
console.log(JSON.stringify(withId({ type: "abort", id: "old" })));
console.log(JSON.stringify(withId({ type: "set_model", provider: "p", modelId: "q" })));
console.log(JSON.stringify(finish(undefined, undefined)));
console.log(JSON.stringify(finish("bad", 3)));
console.log(JSON.stringify(finish(undefined, 4)));
const resolved = relevel({ status: "resolved", name: "a", level: "hi" });
console.log(JSON.stringify(resolved), "level" in resolved, "warning" in resolved);
console.log(JSON.stringify(relevel({ status: "ambiguous", names: ["a", "b"] })));
console.log(JSON.stringify(relevel({ status: "not-found" })));
retrying({ source: "branch" });
retrying({ source: "compact", reason: "auto" });
console.log(events.join(" "));
console.log(JSON.stringify(boundary({ type: "settle", id: "s" }, ["a"])));
console.log(JSON.stringify(boundary({ type: "turn", id: "t", turn: 3 }, ["a", "b"])));
for (const m of replace(
  [
    { role: "user", content: "old" },
    { role: "assistant", content: [], model: "m" },
    { role: "note", body: "n" },
  ],
  "new",
))
  console.log(JSON.stringify(m));
// The spread copies a snapshot: a later write to the source is not seen.
const base: Cmd = { type: "prompt", message: "before" };
const copied = withId(base);
if (base.type === "prompt") base.message = "after";
console.log(JSON.stringify(copied), JSON.stringify(base));
// A spread source whose evaluation changes a value an earlier property
// reads: the earlier property keeps the value from before the spread.
type Src = { kind: "a"; x: number } | { kind: "b"; y: string };
type Stamped = { kind: "a"; x: number; at: number } | { kind: "b"; y: string; at: number };
let clock = 0;
function tick(s: Src): Src {
  clock++;
  return s;
}
const ticked: Src[] = [
  { kind: "a", x: 1 },
  { kind: "b", y: "s" },
];
for (const s of ticked) {
  const stamped: Stamped = { at: clock, ...tick(s) };
  console.log(JSON.stringify(stamped), clock);
}
const constStamp = 7;
const fixed: Stamped = { at: constStamp, ...tick(ticked[0]!) };
console.log(JSON.stringify(fixed), clock);
