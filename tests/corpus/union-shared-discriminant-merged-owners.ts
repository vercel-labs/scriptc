// A union whose arms share a discriminant value takes a value from a
// narrower union when the arms that share the value are one record
// (union-classes.ts): each `type` the source holds then has one owner, and
// the members only some of the arms declare stay absent.
type Event =
  | { type: "begin" }
  | { type: "call"; callId: string; input: any }
  | { type: "retry"; callId: string; input: any };
type SessionEvent =
  | { type: "begin" }
  | { type: "call"; callId: string; input: any; parentId?: string }
  | { type: "call"; callId: string; input: any; parentId?: string; partial: any }
  | { type: "retry"; callId: string; input: any; parentId?: string }
  | { type: "retry"; callId: string; input: any; parentId?: string; partial: any };

function emit(event: SessionEvent): void {
  if (event.type !== "begin") {
    console.log(
      event.type,
      event.callId,
      "partial" in event,
      event.parentId === undefined,
      Object.keys(event).join(","),
    );
    if ("partial" in event) console.log("partial", JSON.stringify(event.partial));
  }
  console.log(JSON.stringify(event));
}

function handle(event: Event): void {
  emit(event);
}

handle({ type: "begin" });
handle({ type: "call", callId: "c1", input: { a: 1 } });
handle({ type: "retry", callId: "c2", input: [1, 2] });
emit({ type: "call", callId: "c3", input: 1, parentId: "p", partial: { x: 1 } });
emit({ type: "retry", callId: "c4", input: null, partial: undefined });
const events: Event[] = [{ type: "call", callId: "c5", input: "s" }, { type: "begin" }];
for (const e of events) handle(e);
