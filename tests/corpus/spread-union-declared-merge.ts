// A union source spread beside a runtime-keyed source into a declared record
// (`{ ...model.compat, ...config.compat }`): a record arm copies its own
// keys, a null or undefined arm copies nothing, and the source evaluates
// once, in order. Keys print sorted: key order through the declared merge
// is a separate, pre-existing limitation.
interface Compat {
  imageInput?: string;
  sendImageOptInHeader?: string;
  maxTokensField?: string;
}
type Small = { imageInput?: string; sendImageOptInHeader?: string };

function merge(a: Small | undefined, b: Record<string, unknown>): Compat {
  return { ...a, ...b };
}
function show(c: Compat): string {
  return [c.imageInput, c.sendImageOptInHeader, c.maxTokensField, "imageInput" in c, Object.keys(c).sort().join(",")].join(" ");
}
console.log(show(merge({ imageInput: "base64", sendImageOptInHeader: "yes" }, { maxTokensField: "max_tokens", imageInput: "url" })));
console.log(show(merge({ sendImageOptInHeader: "no" }, {})));
console.log(show(merge(undefined, { maxTokensField: "max_tokens", imageInput: "url" })));
console.log(show(merge(undefined, {})));

// Several record arms and a null arm: each arm copies its own keys.
type Other = { maxTokensField: string; extra?: string };
function mergeArms(a: Small | Other | null, b: Record<string, unknown>): Compat {
  return { ...b, ...a };
}
console.log(show(mergeArms({ maxTokensField: "own" }, { maxTokensField: "base", imageInput: "i" })));
console.log(show(mergeArms({ imageInput: "own" }, { maxTokensField: "base", imageInput: "i" })));
console.log(show(mergeArms(null, { sendImageOptInHeader: "h" })));
// The source evaluates once, in order.
let calls = 0;
function source(): Small | undefined {
  calls++;
  return calls > 1 ? { imageInput: "second" } : undefined;
}
console.log(show(merge(source(), {})), show(merge(source(), { imageInput: "later" })), calls);
export {};
