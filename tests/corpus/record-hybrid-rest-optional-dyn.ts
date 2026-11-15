// A rest copy of a HYBRID record (declared fields plus `[key: string]:
// unknown`) widened back into the hybrid target, where the rest type no
// longer declares the target's OPTIONAL checked-dynamic field
// (`input?: unknown` in pi's openai-codex-responses request body). The
// field is ABSENT in the copy — the state the rest object really has — so
// `in`, `Object.keys` and JSON answer the source object, and a later write
// still lands in the slot.
type RequestBody = {
  model: string;
  input?: unknown;
  previous_response_id?: string;
  [key: string]: unknown;
};

function withoutInput(body: RequestBody): RequestBody {
  const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
  return rest;
}

const body: RequestBody = { model: "m", input: [1, 2], previous_response_id: "p" };
const stripped = withoutInput(body);
console.log(JSON.stringify(stripped));
console.log("input" in stripped, "previous_response_id" in stripped);
console.log(Object.keys(stripped).join(","));

stripped.input = 7;
console.log(JSON.stringify(stripped), "input" in stripped);

// The widening also runs on a value that never had the field.
const bare: RequestBody = { model: "b" };
const bareStripped = withoutInput(bare);
console.log(JSON.stringify(bareStripped), Object.keys(bareStripped).join(","));
