// An optional call of a standard-library method that always exists on a
// never-nullish receiver is the plain call (`getSetCookie?.()` is always
// present on Node 24).
const h = new Headers();
h.append("set-cookie", "a=1");
h.append("set-cookie", "b=2");
const cookies = h.getSetCookie?.() ?? [];
console.log(JSON.stringify(cookies));
console.log(h.get?.("set-cookie"));
console.log(h.has?.("x-missing"));
h.set?.("x-set", "1");
h.forEach?.((value, name) => console.log(`${name}=${value}`));

// The receiver evaluates once; arguments evaluate after it.
let reads = 0;
function headers(): Headers {
  reads++;
  return h;
}
function arg(): string {
  console.log("argument after receiver", reads);
  return "x-set";
}
console.log(headers().get?.(arg()), reads);

// Strings and arrays: the same rule.
const s = "Hello";
console.log(s.toUpperCase?.(), [3, 1, 2].sort?.().join(","));
