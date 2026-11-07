// A union whose arms share a discriminant value routes a value by that
// property only when every value the source can hold has one owner arm.
// Here each `type` the source holds has two owners, both take the value by
// width, and no other property tells them apart, so the conversion stays
// refused. The two owners cannot be one record either: they declare `note`
// with two types.
type Event =
  | { type: "begin" }
  | { type: "call"; callId: string; input: any }
  | { type: "retry"; callId: string; input: any };
type SessionEvent =
  | { type: "begin" }
  | { type: "call"; callId: string; input: any; parentId?: string; note?: string }
  | { type: "call"; callId: string; input: any; parentId?: string; note?: number; partial: any }
  | { type: "retry"; callId: string; input: any; parentId?: string; note?: string }
  | { type: "retry"; callId: string; input: any; parentId?: string; note?: number; partial: any };

function emit(event: SessionEvent): void {
  console.log(JSON.stringify(event));
}

function handle(event: Event): void {
  emit(event);
}

handle({ type: "begin" });
