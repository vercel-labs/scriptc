// A declared spread merge (`{ ...a, ...b }` into one declared shape)
// enumerates its keys in Node's insertion order — the sources' own keys in
// spread order, an override keeping the earlier position, later keys
// appending — on every order-observing surface, not the target's declared
// field order. Differentially vs Node: JSON.stringify, Object.keys/values/
// entries, for-in, util.inspect, and a spread copy of the result.
import { inspect } from "node:util";

// Deliberately non-alphabetical declarations, so neither the declared
// field order nor a name-sorted layout can pass.
interface Compat {
  imageInput?: string;
  sendImageOptInHeader?: string;
  maxTokensField?: string;
}
type Small = { sendImageOptInHeader?: string; imageInput?: string };

function merge(a: Small, b: Record<string, unknown>): Compat {
  return { ...a, ...b };
}

// Source order decides, not the declaration order of Small or Compat.
const one = merge({ imageInput: "i", sendImageOptInHeader: "h" }, { maxTokensField: "m" });
console.log(JSON.stringify(one));
const two = merge({ sendImageOptInHeader: "h", imageInput: "i" }, { maxTokensField: "m" });
console.log(JSON.stringify(two));
console.log(Object.keys(two).join(","));
console.log(Object.values(two).join(","));
console.log(Object.entries(two).map((e) => e[0]).join(","));
let forIn = "";
for (const k in two) forIn += `${k},`;
console.log(forIn);
console.log(inspect(two));
console.log(JSON.stringify(two, null, 2));

// A copy of the result keeps its order too.
const copy = { ...two };
console.log(Object.keys(copy).join(","));
console.log(JSON.stringify(copy));

// An override keeps the earlier position; a new key appends after it.
const overridden = merge({ imageInput: "i", sendImageOptInHeader: "h" }, { sendImageOptInHeader: "H", maxTokensField: "m" });
console.log(JSON.stringify(overridden));
console.log(overridden.sendImageOptInHeader, overridden.imageInput, overridden.maxTokensField);

// Partial sources: absent optionals contribute no key and never reorder
// the ones that are present.
console.log(JSON.stringify(merge({ sendImageOptInHeader: "h" }, { imageInput: "i" })));
console.log(JSON.stringify(merge({ imageInput: "i" }, {})));
console.log(JSON.stringify(merge({}, { maxTokensField: "m" })));
console.log(JSON.stringify(merge({}, {})));
const empty = merge({}, {});
console.log(Object.keys(empty).length, "maxTokensField" in empty);

// A dictionary source contributes its own insertion order, including keys
// that only it supplies.
const dict: Record<string, unknown> = {};
dict["maxTokensField"] = "z";
dict["imageInput"] = "y";
console.log(JSON.stringify(merge({}, dict)));
console.log(JSON.stringify(merge({ sendImageOptInHeader: "h" }, dict)));

// A kept merge feeding another declared merge keeps its order through it.
function remerge(base: Compat, b: Record<string, unknown>): Compat {
  return { ...base, ...b };
}
const chained = remerge(two, { maxTokensField: "M" });
console.log(JSON.stringify(chained));
console.log(Object.keys(chained).join(","));

// Values stay live: the same shape read through the kept view.
console.log(two.imageInput, two.sendImageOptInHeader, two.maxTokensField);
console.log("done");
