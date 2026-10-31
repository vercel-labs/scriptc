// A union whose arms declare the same field with DIFFERENT storage types,
// one of them `unknown` (`BashResult["details"]` beside the pi
// ToolResultEvent's `details: unknown` arm). TypeScript's writable property
// type on a union is the union of the arms' property types, so the value is
// lowered once at its own type and each arm's slot converts it — a widening
// for the arm that stores it exactly, a checked conversion for the narrower
// arms. Reads project every arm through the checked-dynamic representation
// (a copy for a record that narrows back out of the dynamic tree, the
// documented dyn→static stance).
interface BashResult {
  type: "tool_result";
  toolName: "bash";
  details: { trunc?: string } | undefined;
}
interface ReadResult {
  type: "tool_result";
  toolName: "read";
  details: { lines?: number } | undefined;
}
interface CustomResult {
  type: "tool_result";
  toolName: string;
  details: unknown;
}
type Result = BashResult | ReadResult | CustomResult;

function attach(result: Result, payload: unknown): Result {
  result.details = payload;
  return result;
}

const payload = { trunc: "…", lines: 3 };
const bash: BashResult = { type: "tool_result", toolName: "bash", details: undefined };
const tagged = attach(bash, payload);
console.log(JSON.stringify(tagged));
console.log(JSON.stringify(tagged.details));
console.log(typeof tagged.details, tagged.toolName);

// The payload of a NARROWER arm stores through its free widening there.
const exact: BashResult = { type: "tool_result", toolName: "bash", details: undefined };
attach(exact, { trunc: "kept" });
console.log(JSON.stringify(exact));

const read: ReadResult = { type: "tool_result", toolName: "read", details: undefined };
attach(read, { lines: 17 });
console.log(JSON.stringify(read));

// Assignment in expression position yields the value as written.
const custom: CustomResult = { type: "tool_result", toolName: "grep", details: undefined };
const value = (custom.details = payload);
console.log(typeof value, JSON.stringify(custom), value === payload);

// An undefined payload clears the field through the dynamic arm.
const cleared: CustomResult = { type: "tool_result", toolName: "custom", details: "before" };
attach(cleared, undefined);
console.log(JSON.stringify(cleared), typeof cleared.details);

// A receiver that is already the union (no narrowing in play).
function attachAll(results: Result[], payload: unknown): void {
  for (const result of results) result.details = payload;
}
attachAll([exact, read, cleared], { lines: 1 });
console.log(JSON.stringify([exact, read, cleared]));
