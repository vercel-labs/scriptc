// A record field the checker types `any`/`unknown` flowing into a slot whose
// declared type is a UNION: the checked extraction (dynCheck) is the
// conversion, exactly as for a dyn value in a top-level union slot. Before
// this, such a field only lifted into a NON-union destination, so a tool
// result's `details: unknown` could not reach `Details | undefined`, a
// `structuredContent: unknown` could not reach a JSON-value union, and a
// spread's dynamic key could not reach an index-signature member.
interface Details {
  limit: number;
  flag?: boolean;
}

interface Wide {
  label: string;
  details: any;
}
interface Narrow {
  label: string;
  details: Details | undefined;
}

function narrow(w: Wide): Narrow {
  return w;
}

type Json = string | number | boolean | null | { [key: string]: Json } | Json[];
interface Payload {
  text: string;
  structuredContent: any;
}
interface JsonPayload {
  text: string;
  structuredContent: Json | undefined;
}

function widen(p: Payload): JsonPayload {
  return p;
}

// A spread whose source carries the dynamic field: the same field lift.
interface Built {
  content: string;
  sections: any;
}
interface Message {
  role: string;
  content: string;
  sections: { [key: string]: string | null } | undefined;
  timestamp: number;
}
function fromState(flag: boolean): Built {
  return { content: flag ? "on" : "off", sections: { preamble: "p" } };
}
function message(flag: boolean): Message {
  return { role: "system", ...fromState(flag), timestamp: 0 };
}

// A callback whose result parameter narrows the dynamic field back to a
// record type adapts into the slot's dynamic-details signature.
interface SlotResult {
  content: { type: string; text: string }[];
  details: any;
}
interface ToolResult {
  content: { type: string; text: string }[];
  details: { limit: number } | undefined;
}
type Renderer = (result: SlotResult, expanded: boolean) => string;
function format(result: ToolResult, expanded: boolean): string {
  return `${result.content.length}:${result.details?.limit ?? "none"}:${expanded}`;
}
const render: Renderer = (result, expanded) => format(result, expanded);

const wide: Wide = { label: "a", details: { limit: 3 } };
const n = narrow(wide);
console.log(n.label, n.details === undefined ? "none" : n.details.limit);

const p = widen({ text: "t", structuredContent: { nested: [1, true, null] } });
console.log(p.text, JSON.stringify(p.structuredContent ?? null));

const m = message(true);
console.log(m.role, m.content, m.timestamp, m.sections?.["preamble"] ?? "-");

console.log(render({ content: [{ type: "text", text: "abc" }], details: { limit: 7 } }, true));
console.log(render({ content: [], details: undefined }, false));
