// A package that fences at module initialization (`class … extends Promise`)
// runs in a Node island in a build, exactly as the provider SDKs do. Its
// declarations then type the program's values as island handles, so the
// writes, pushes and reads below are dynamic operations on the island's
// object — not refusals the build would not make.
import { send, assistant } from "ni-sdk";
import type { Params, Input, MessageParam, AssistantParam, Create } from "ni-sdk";

const params: Params = { model: "m", stream: true };
params.temperature = 0.5;
params.tools = [{ type: "function", name: "t" }];

const input: Input = [];
if (input.length === 0) input.push({ role: "user", content: "hi" });
const out: MessageParam[] = [];
const pending: MessageParam[] = [assistant()];
out.push(...pending);
pending.length = 0;

type WithReasoning = AssistantParam & { reasoning_content?: string };
const msg: WithReasoning = { role: "assistant", content: null };
msg.reasoning_content = "";
const content = msg.content;
const has = content != null && (typeof content === "string" ? content.length > 0 : content.length > 0);

const betas: Create["betas"] = ["beta-a"];
console.log(send(params, input, betas), out.length, has, msg.reasoning_content);
