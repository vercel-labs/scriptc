// new URLSearchParams(c ? a : b) builds from the arm the condition
// selects; each arm may be a record literal, a string, pairs or another
// URLSearchParams.
let checks = 0;
function flag(value: boolean): boolean {
  checks++;
  return value;
}
for (const on of [true, false]) {
  const params = new URLSearchParams(flag(on) ? { code: "x y", state: "s&t" } : {});
  console.log(params.toString(), params.size);
  const query = new URLSearchParams(on ? "a=1&b=2" : [["c", "3"]]);
  console.log(query.toString());
  const base = new URLSearchParams("keep=1");
  const copy = new URLSearchParams(on ? base : undefined);
  copy.append("more", "2");
  console.log(copy.toString(), base.toString());
  const nested = new URLSearchParams(on ? (checks > 1 ? { n: "2" } : { n: "1" }) : "?empty=");
  console.log(nested.toString());
}
console.log(checks);
