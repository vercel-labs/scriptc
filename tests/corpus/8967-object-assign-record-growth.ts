// Object.assign(target, source) where the source carries keys the target's
// declared type does not — the coding agent's `Object.assign(tool, {
// promptSnippet, promptGuidelines })` (bash.ts:437, powershell.ts:62). The
// declared keys write in place and the added ones join the record's kept
// source, so every reference to the one object, Object.keys, JSON, `in`,
// hasOwn, spread, a re-assigned key and a frozen target agree with Node.
interface Def {
  name: string;
  snippet: string;
  guidelines?: readonly string[];
}
interface Tool {
  name: string;
  label: string;
  run: (x: number) => number;
  notes?: readonly string[];
}

function wrap(def: Def): Tool {
  return { name: def.name, label: def.name.toUpperCase(), run: (x) => x + 1 };
}

const registry: Tool[] = [];

function createTool(def: Def): Tool {
  const tool = wrap(def);
  registry.push(tool); // an alias taken before the growth
  Object.assign(tool, { snippet: def.snippet, guidelines: def.guidelines });
  return tool;
}

const def: Def = { name: "sh", snippet: "run shell", guidelines: ["be careful"] };
const tool = createTool(def);
console.log("alias:", registry[0] === tool, tool.run(1));
console.log("keys:", Object.keys(tool).join(","));
console.log("json:", JSON.stringify(tool));
console.log("alias json:", JSON.stringify(registry[0]));
console.log("present:", "snippet" in tool, Object.hasOwn(registry[0]!, "guidelines"));
console.log(
  "entries:",
  Object.entries(tool)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? "array" : typeof value}`)
    .join(","),
);
const copy = { ...tool };
console.log("spread:", Object.keys(copy).join(","), JSON.stringify(copy));
const anyTool = tool as any;
console.log(
  "added through any:",
  anyTool.snippet,
  anyTool.guidelines === def.guidelines,
  Array.isArray(anyTool.guidelines),
);

// A re-assigned added key keeps its position, and a later add follows it.
Object.assign(tool, { snippet: "second" });
console.log("reassigned:", Object.keys(tool).join(","), JSON.stringify(tool));
Object.assign(tool, { extra: 7 });
console.log("third:", Object.keys(tool).join(","), JSON.stringify(tool));

// A frozen target refuses the addition with Node's TypeError, and the
// refused write leaves the record as it was.
const frozen = wrap({ name: "pwsh", snippet: "" });
Object.freeze(frozen);
try {
  Object.assign(frozen, { snippet: "x" });
} catch (err) {
  console.log("frozen:", err instanceof TypeError, (err as Error).message);
}
console.log("frozen keys:", Object.keys(frozen).join(","), JSON.stringify(frozen));
