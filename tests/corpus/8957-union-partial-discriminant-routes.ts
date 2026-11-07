// A value entering a union whose discriminant only tells some arms apart
// still enters by its discriminant value: the arms its own type rules out
// do not count, and the property that then has one owner per value picks
// the arm.

// A catch-all arm (`op: string`) owns no literal. A success reply cannot be
// it (`ok: true` against `ok: false`), so `op` selects among the others.
type Request = { op: "open"; path: string } | { op: "close" } | { op: "list" };
type Reply =
  | { id?: string; kind: "reply"; op: "open"; ok: true; data: { handle: number } }
  | { id?: string; kind: "reply"; op: "close"; ok: true }
  | { id?: string; kind: "reply"; op: "list"; ok: true; data: { names: string[]; more: boolean } }
  | { id?: string; kind: "reply"; op: string; ok: false; error: string };
const done = <T extends Request["op"]>(id: string | undefined, op: T, data?: object | null): Reply => {
  if (data === undefined) return { id, kind: "reply", op, ok: true } as Reply;
  return { id, kind: "reply", op, ok: true, data } as Reply;
};
const failed = (id: string | undefined, op: string, message: string): Reply => ({
  id,
  kind: "reply",
  op,
  ok: false,
  error: message,
});
const show = (reply: Reply): void => console.log(JSON.stringify(reply));
show(done("1", "open", { handle: 7 }));
show(done(undefined, "close"));
show(done("3", "list", { names: ["a", "b"], more: false }));
show(failed("4", "x", "bad"));
const opened = done("5", "open", { handle: 9 });
if (opened.ok && opened.op === "open") console.log(opened.data.handle + 1);
const listed = done("6", "list", { names: ["x", "y"], more: true });
if (listed.ok && listed.op === "list") console.log(listed.data.names.join(), listed.data.more);
const replies: Reply[] = [opened, listed, failed(undefined, "open", "denied")];
console.log(replies.map((reply) => (reply.ok ? reply.op : `${reply.op}:${reply.error}`)).join(" "));

// Two arms share one `type` value, so the union has no discriminant. A
// source event that cannot carry that value is routed by `type` all the
// same, into the one arm that names its value.
type Note = { author: string; text: string };
type Event =
  | { type: "begin" }
  | { type: "end"; notes: Note[] }
  | { type: "note"; note: Note }
  | { type: "call"; callId: string; input: any }
  | { type: "progress"; callId: string; input: any; partial: any }
  | { type: "result"; callId: string; output: any; failed: boolean; elapsed?: number };
type WithParent<E> = E extends { type: "call" | "progress" | "result" } ? E & { parentId?: string } : E;
type SessionEvent =
  | WithParent<Exclude<Event, { type: "end" }>>
  | { type: "end"; notes: Note[]; again: boolean }
  | { type: "idle"; stopped: boolean }
  | { type: "retry"; source: "branch" }
  | { type: "retry"; source: "trim"; reason: "manual" | "overflow" };
const seen: SessionEvent[] = [];
function emit(event: SessionEvent): void {
  seen.push(event);
  console.log(JSON.stringify(event));
}
function again(event: Extract<Event, { type: "end" }>): boolean {
  return event.notes.length > 1;
}
function handle(event: Event): void {
  emit(event.type === "end" ? { ...event, again: again(event) } : event);
}
handle({ type: "begin" });
handle({ type: "note", note: { author: "u", text: "hi" } });
handle({ type: "call", callId: "c1", input: { cmd: "ls" } });
handle({ type: "progress", callId: "c1", input: { cmd: "ls" }, partial: ["a"] });
handle({ type: "result", callId: "c1", output: { ok: true }, failed: false });
handle({ type: "end", notes: [{ author: "u", text: "a" }, { author: "m", text: "b" }] });
emit({ type: "retry", source: "trim", reason: "overflow" });
emit({ type: "idle", stopped: false });
const last = seen[5]!;
if (last.type === "end") console.log(last.again, last.notes.length);
const call = seen[2]!;
if (call.type === "call") console.log(call.callId, call.parentId ?? "-", JSON.stringify(call.input));
console.log(seen.map((event) => event.type).join(" "));
