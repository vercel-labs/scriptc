// @requires-libnode
// A union with a primitive arm beside an island object arm crosses into the
// island: its native representation is checked-dynamic, where the runtime
// copies the primitive and exports the object itself. The crossing is
// decided by that representation, not by the TypeScript arms (SPEC 1 = B).
import {
  create,
  keep,
  mutateKeptName,
  params,
  same,
  send,
  type Choice,
  type Input,
  type Part,
} from "union-pkg";

// 1. A `Choice` assigned into an island handle's field: the string arms
// copy, the object arm is the program's own object.
interface Opts {
  choice?: Choice;
}
function build(opts: Opts): string {
  const p = params();
  if (opts.choice !== undefined) p.tool_choice = opts.choice;
  return create(p);
}
console.log(build({ choice: "auto" }));
console.log(build({ choice: "none" }));
const chosen = { type: "function" as const, name: "lookup" };
console.log(build({ choice: chosen }));
console.log(build({}));

// 2. The object arm keeps its identity across the boundary: the island keeps
// it, compares it to the object handed to it again, and a write the island
// makes is visible here.
keep(chosen);
console.log("kept", same(chosen));
mutateKeptName();
console.log("name", chosen.name);

// 3. A generic push of a record holding `string | Array<Part | …>`: the
// island's own `Input` array receives the record, and `send` reads it back.
type Out = Array<Part | { type: "image"; url: string }>;
function conv(n: number): string | Out {
  if (n === 0) return "plain";
  return [{ type: "text", text: "t" + n }];
}
function convert<T extends string>(model: T, n: number): string {
  const messages: Input = [];
  for (let i = 0; i < n; i++) {
    const callId = model + ":" + i;
    const output = conv(i);
    messages.push({ type: "out", call_id: callId, output });
  }
  return send(messages);
}
console.log(convert<string>("m", 2));
