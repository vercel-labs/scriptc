// A Record<string, Input> target stores its values in Input's declared
// layout, but a value written into it enumerates its own keys in the order
// it was created, as Node's object does. Differentially vs Node.
interface Input {
  type: string;
  description: string;
  flag?: string;
  falseFlag?: string;
  items?: Record<string, unknown>;
}
const STRING_ITEMS = { type: "string" };
const SHARED_INPUTS: Record<string, Input> = {
  extraArgs: { type: "array", items: STRING_ITEMS, description: "d" },
};
const inputs: Record<string, Input> = {};
inputs.prompt = {
  type: "string",
  description: "p",
  ...(true ? { items: STRING_ITEMS } : {}),
  flag: "--p",
};
inputs.extraArgs = SHARED_INPUTS.extraArgs;
console.log(JSON.stringify(inputs.extraArgs));
console.log(Object.keys(inputs.extraArgs).join(","));
console.log(Object.keys(inputs.prompt).join(","));
console.log(JSON.stringify(inputs));

// A value that arrived as dynamic data and is stored into another
// Record<string, Input> keeps the order it came with.
const parsedInputs = JSON.parse(
  '{"k":{"type":"x","items":{"type":"string"},"description":"d"}}'
) as Record<string, Input>;
const bag: Record<string, Input> = {};
bag.k = parsedInputs.k;
console.log(JSON.stringify(bag.k), Object.keys(bag.k).join(","));

// The conditional branch's key is absent at run time: the literal keeps its
// remaining keys in creation order (the absent key occupies no slot).
const withoutItems: Input = {
  type: "string",
  description: "d",
  ...(false ? { items: STRING_ITEMS } : {}),
  flag: "--f",
};
console.log(Object.keys(withoutItems).join(","), JSON.stringify(withoutItems));
