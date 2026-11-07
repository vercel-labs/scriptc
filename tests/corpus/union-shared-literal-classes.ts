// A union in which two members share one discriminant literal. The members that share it are one kind
// of object (one class, one record), and the literal member decides between classes, so an event of a
// narrower union finds its arm by its literal, from a typed value and from JSON alike.
type Msg = { role: string; text: string };
type Core =
  | { type: "start" }
  | { type: "end"; messages: Msg[] }
  | { type: "msg"; message: Msg }
  | { type: "tool_start"; id: string; name: string; args: any }
  | { type: "tool_update"; id: string; name: string; args: any; partial: any }
  | { type: "tool_end"; id: string; name: string; result: any; failed: boolean; ms?: number };
type WithParent<E> = E extends { type: "tool_start" | "tool_update" | "tool_end" }
  ? E & { parent?: string }
  : E;
type Session =
  | WithParent<Exclude<Core, { type: "end" }>>
  | { type: "end"; messages: Msg[]; willRetry: boolean }
  | { type: "settled"; aborted: boolean }
  | { type: "retry"; source: "branch" }
  | { type: "retry"; source: "compaction"; reason: "manual" | "overflow" };

const seen: Session[] = [];
function emit(e: Session): void {
  seen.push(e);
  console.log(JSON.stringify(e));
}
function describe(e: Session): string {
  switch (e.type) {
    case "start":
      return "start";
    case "end":
      return "end " + e.messages.length + " " + e.willRetry;
    case "msg":
      return "msg " + e.message.text;
    case "tool_start":
      return "tool_start " + e.name + " " + (e.parent ?? "top");
    case "tool_update":
      return "tool_update " + String(e.partial);
    case "tool_end":
      return "tool_end " + e.failed + " " + (e.ms ?? -1);
    case "settled":
      return "settled " + e.aborted;
    case "retry":
      return e.source === "compaction" ? "retry compaction " + e.reason : "retry branch";
  }
}

// A core event becomes a session event: through a conditional, and through an assertion.
function forward(event: Core): void {
  emit(event.type === "end" ? { ...event, willRetry: event.messages.length > 1 } : event);
}
function forwardAsserted(event: Core): void {
  if (event.type === "end") emit({ ...event, willRetry: false });
  else emit(event as Session);
}
const core: Core[] = [
  { type: "start" },
  { type: "msg", message: { role: "user", text: "hi" } },
  { type: "tool_start", id: "t1", name: "bash", args: { cmd: "ls" } },
  { type: "tool_update", id: "t1", name: "bash", args: { cmd: "ls" }, partial: "a" },
  { type: "tool_end", id: "t1", name: "bash", result: { ok: true }, failed: false },
  { type: "end", messages: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }] },
];
for (const event of core) forward(event);
for (const event of core) forwardAsserted(event);

// The two members of the class, built at the union's type.
emit({ type: "retry", source: "branch" });
emit({ type: "retry", source: "compaction", reason: "manual" });
emit({ type: "settled", aborted: false });
emit({ type: "tool_start", id: "t2", name: "read", args: [1], parent: "t1" });
for (const e of seen) console.log(describe(e));

// Narrowing inside the class: by the second literal, and by presence.
for (const e of seen) {
  if (e.type !== "retry") continue;
  console.log(Object.keys(e).join(","), "reason" in e, "reason" in e ? e.reason : "none");
  if (e.source === "compaction") console.log(e.reason.length);
}

// The same values from JSON, and through `unknown`.
const parsed = JSON.parse(
  '[{"type":"retry","source":"compaction","reason":"overflow"},{"type":"retry","source":"branch"},' +
    '{"type":"tool_start","id":"t9","name":"read","args":[1],"parent":"t1"},' +
    '{"type":"tool_start","id":"t8","name":"bash","args":{}},{"type":"settled","aborted":true}]',
) as Session[];
for (const e of parsed) console.log(describe(e), JSON.stringify(e), Object.keys(e).join(","));
const loose: unknown[] = [...seen];
let matched = 0;
for (let i = 0; i < loose.length; i++) {
  const e = loose[i] as Session;
  if (describe(e) === describe(seen[i]!)) matched++;
}
console.log(matched, loose.length);

// The class's members as a type of their own.
type Retry = Extract<Session, { type: "retry" }>;
function retries(events: Session[]): Retry[] {
  return events.filter((e): e is Retry => e.type === "retry");
}
for (const r of retries(seen)) console.log(r.source, r.source === "compaction" ? r.reason : "-");
