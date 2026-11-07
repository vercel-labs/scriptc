// @requires-libnode
// An island object the program types with its own record types stays one
// live object (wave-2 6 = C): the value is a checked-identity view, so every
// type receiving island values keeps the handle and the island's later
// mutations are visible, a member passed to a program function reads live,
// and no copy splits identity. This is what #3005 refused as SC8010.
import { nextEvent, load, touchEvent, bump, same } from "island-pkg";

type Colors<V> = { accent: V; muted: V };

function describe(colors: Colors<string | number>, vars: Record<string, string | number>): string {
  return `${colors.accent}|${colors.muted}|${Object.keys(vars).join(",")}|${vars.base}`;
}

// anthropic-messages.ts:866's shape: a program-declared side member of an
// island object, read twice around a write the island makes.
const event = nextEvent();
const cacheCreation = (
  event.usage as typeof event.usage & { cache_creation?: { ephemeral_1h_input_tokens?: number } }
).cache_creation;
if (cacheCreation?.ephemeral_1h_input_tokens != null)
  console.log(cacheCreation.ephemeral_1h_input_tokens);
touchEvent();
console.log(cacheCreation?.ephemeral_1h_input_tokens);

// theme.ts:527/:857's shape: an island document's program-typed members flow
// into a program function, including `doc.vars ?? {}`.
const doc = load<Colors<string | number>>();
const vars = doc.vars ?? {};
console.log(describe(doc.colors, vars), doc.name);
console.log(same(doc.colors));

// A program function's parameter keeps the handle too: a copy at the call
// would serve the value the island had then, never the one it writes after.
let held: Colors<string | number> | null = null;
function hold(colors: Colors<string | number>): void {
  held = colors;
}
hold(doc.colors);
console.log(same(held!));

bump();
console.log(describe(doc.colors, vars), doc.name);
console.log(same(doc.colors), same(held!), held!.accent);
