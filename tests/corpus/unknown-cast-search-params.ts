// A URLSearchParams value held as `unknown` and cast back: the checked cast
// answers the same object.
function throughUnknown<T>(value: T): T {
  const held: unknown = value;
  return held as T;
}

const params = new URLSearchParams("a=1&b=two&a=3");
const back = throughUnknown(params);
console.log(back === params, back.getAll("a").join(","), back.get("b"), back.toString());
back.append("c", "4");
console.log(params.has("c"), params.size);

const url = throughUnknown(new URL("https://example.com/p?x=1"));
console.log(url.searchParams.get("x"), url.pathname);
