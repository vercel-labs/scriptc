// @requires-libnode
// The shapes pi's request builders use on a value typed by an islanded
// package: the request object is a handle, so writes, pushes, keyed writes
// and `.length` all run in the island, and the mutation the island makes is
// visible here. Node IS the oracle: the same program runs under Node against
// the same package.
import {
  create,
  same,
  assistant,
  type AssistantParam,
  type Input,
  type MessageParam,
  type Params,
  type Tool,
} from "sdkpkg";

// 1. A request literal with undefined members, optional-member writes and
// `as any` writes. The value is a native literal typed by the island package,
// so it crosses as a handle; every write goes through the island, and the
// island's JSON.stringify sees it.
const params: Params = {
  model: "gpt-4o",
  stream: true,
  temperature: undefined,
  tools: undefined,
  stream_options: undefined,
  metadata: { tag: "t1" },
};
params.temperature = 0.2;
params.tools = [{ type: "function", name: "lookup" }];
(params as any).prompt_cache_key = "cache-1";
(params as any).stream_options = { include_usage: true };
console.log("keys", JSON.stringify(Object.keys(params)));

// 2. Pushes into an island alias array, a spread push, and `.length`.
const input: Input = [];
if (input.length === 0) input.push({ role: "user", content: "hi" });
console.log("input", input.length, JSON.stringify(input));
const pending: MessageParam[] = [
  { role: "user", content: "next" },
  { role: "assistant", content: null },
];
const out: MessageParam[] = [];
out.push(...pending);
console.log("out", out.length, JSON.stringify(out));

// 3. `satisfies` with a conditional spread.
const tools: Tool[] = [{ type: "function", name: "a" }];
const request = {
  model: "gpt-4o",
  stream: true as const,
  ...(tools.length > 0 ? { tools } : {}),
} satisfies Params;
console.log("satisfies", JSON.stringify(Object.keys(request)), JSON.stringify(request.tools));

// 4. `.length = 0` on an island-typed array.
const queue: MessageParam[] = [{ role: "user", content: "q" }];
queue.push({ role: "user", content: "r" });
queue.length = 0;
console.log("trunc", queue.length, JSON.stringify(queue));

// 5. An intersection with an island arm, and a keyed write through it.
const msg: AssistantParam & { reasoning_content?: string } = {
  role: "assistant",
  content: null,
};
msg.reasoning_content = "";
const field: "reasoning_content" | "content" = "reasoning_content";
msg[field] = "because";
console.log("intersection", JSON.stringify(msg));

// 6. A mixed-union read.
const content = msg.content;
const has =
  content != null &&
  (typeof content === "string" ? content.length > 0 : content.length > 0);
console.log("union", has, Array.isArray(content) ? content[0] : typeof content);

// 7. The island mutates params, and the mutation is visible natively.
const betas: string[] = ["beta-a"];
const res = create(params, input, { betas });
console.log("id", res.id);
console.log("choice", res.choices[0]!.message.content);
console.log("calls", res.choices.length, res.choices[0]!.message.tool_calls.length);
console.log("normalized", (params as any).normalized, JSON.stringify(Object.keys(params)));

// 8. Identity: params is itself through the island; the island's response
// object is a different object.
console.log("identity", same(params) === params, res !== (params as any), assistant() !== assistant());

// 9. Integer-like keys on an island-typed value: JavaScript's own ordering
// puts them first, in ascending order, ahead of the string keys.
const ordered: Params = { model: "m", stream: true };
(ordered as any)["b"] = 1;
(ordered as any)["2"] = 2;
(ordered as any)["1"] = 3;
console.log("order", JSON.stringify(Object.keys(ordered)));
