// @requires-libnode
// A type assertion on a handle is a view, never a conversion: Node erases
// `as`, so `(p as V).k = v` writes the very object `p` names, and a read
// through the view meets the member's declared type. Every operation below
// has to reach the island, and the island's own JSON.stringify has to see
// exactly what Node's would.
import { assistant, send, type Params } from "sdk-pkg";

const params: Params = { model: "m", stream: true };
(params as any).x = 1;
(params as { max_tokens?: number }).max_tokens = 2;
(params as typeof params & { r?: { e: string } }).r = { e: "deep" };
(params as any).n = 1;
(params as any).n += 1;
const key = "via-key" as const;
(params as any)[key] = "keyed";
console.log("read", (params as { max_tokens?: number }).max_tokens);
console.log(send(params, [], undefined));

// The same through a chain of assertions, and on a value the island made.
const chained = params as unknown as { nested?: { list: number[] } };
chained.nested = { list: [1, 2] };
console.log(send(params, [], undefined));

const msg = assistant();
(msg as { reasoning_content?: string }).reasoning_content = "why";
(msg as any).tool_calls = [{ id: "call-1" }];
console.log("msg", (msg as { reasoning_content?: string }).reasoning_content);
console.log("calls", (msg as { tool_calls?: Array<{ id: string }> }).tool_calls?.[0]?.id);
