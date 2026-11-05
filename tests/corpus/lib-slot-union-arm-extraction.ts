// A checked-dynamic JSON stringify — a record or array carrying an `unknown`
// field — answers `string | undefined` in the IR (the runtime walker can
// return undefined for a dyn root) while the checker types the call `string`.
// Reading a string member of that result is the checked ARM extraction at the
// stdlib slot: the proven arm's payload comes out, and the absent arm would
// throw the catchable TypeError instead of the call being refused.

interface Tool {
  name: string;
  parameters: unknown;
}

function sizes(tools: Tool[], extra: { note: string; value: unknown }): string {
  const text = JSON.stringify(tools);
  let chars = 0;
  chars += text.length;
  if (tools.length > 0) chars += JSON.stringify(tools[0]).length;
  chars += JSON.stringify(extra).slice(0, 24).length;
  chars += JSON.stringify({ tools }).toUpperCase().slice(0, 12).length;
  chars += JSON.stringify(tools).indexOf('"name"');
  chars += `raw:${JSON.stringify(extra)}`.length > 0 ? 1 : 0;
  return `${chars} ${text.length} ${JSON.stringify({ tools }).slice(0, 12)}`;
}

console.log(sizes([{ name: "alpha", parameters: { a: 1 } }], { note: "n", value: null }));
console.log(sizes([{ name: "beta", parameters: undefined }], { note: "empty", value: [1, 2] }));
console.log(sizes([], { note: "none", value: { nested: { deep: true } } }));
console.log(sizes([{ name: "gamma", parameters: "s" }], { note: "deep", value: { a: [1, { b: 2 }] } }));

// The same string result feeding a comparison and a concatenation.
const one = JSON.stringify({ name: "x", parameters: 1 });
const two = JSON.stringify({ parameters: 1, name: "x" });
console.log(one === two, one < two, ("p" + one).length);
