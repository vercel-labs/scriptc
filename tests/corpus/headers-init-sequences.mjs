// The HeadersInit sequence branch: Node converts any iterable of pairs, not
// just an array, and its messages name the element's position for everything
// that is not one.
const show = (label, fn) => {
  try {
    console.log(label, "ok", JSON.stringify(fn()));
  } catch (e) {
    console.log(label, "throw", e.constructor.name, JSON.stringify(e.message));
  }
};
show("map", () => [...new Headers(new Map([["m", "1"], ["M", "2"]]))]);
show("map empty", () => [...new Headers(new Map())]);
show("set", () => [...new Headers(new Set([["s", "1"]]))]);
show("array dup", () => [...new Headers([["a", "1"], ["A", "2"]])]);
show("number element", () => [...new Headers([1])]);
show("string element", () => [...new Headers(["xy"])]);
show("object element", () => [...new Headers([{}])]);
show("long pair", () => [...new Headers([["a", "1", "x"]])]);
show("symbol member", () => [...new Headers([[Symbol("s"), "1"]])]);
show("coerced members", () => [...new Headers([[1, 2], [true, false]])]);
show("nullish members", () => [...new Headers([[null, null], [undefined, undefined]])]);
show("typed init", () => [...new Headers(new Uint8Array([1, 2]))]);
show("typed element", () => [...new Headers([new Uint8Array([97, 49])])]);
show("response map", () => [...new Response(null, { headers: new Map([["x", "1"]]) }).headers]);
show("empty", () => [...new Headers([])]);
show("undefined", () => [...new Headers(undefined)]);
show("null", () => [...new Headers(null)]);
show("string init", () => [...new Headers("ab")]);
