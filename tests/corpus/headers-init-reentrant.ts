// A pair's members are read from the live pair: a member's toString is
// program code that can grow, shrink or rewrite the pair (and the init array)
// it belongs to, and Node reads member 0, converts it, reads member 1,
// converts it, and only then checks the pair's length. Nothing may keep a
// pointer into the pair's storage across those conversions.
const show = (label: string, fn: () => unknown): void => {
  try {
    console.log(label, "ok", JSON.stringify(fn()));
  } catch (e) {
    const error = e as any;
    console.log(label, "throw", error.constructor.name, JSON.stringify(error.message));
  }
};
show("name grows pair", () => {
  const pair: any[] = [];
  pair.push("a");
  pair.push("1");
  pair[0] = { toString() { pair.push("z"); return "a"; } };
  return [...new Headers([pair] as any)];
});
show("value grows pair", () => {
  const pair: any[] = [];
  pair.push("a");
  pair.push("1");
  pair[1] = { toString() { pair.push("z"); return "1"; } };
  return [...new Headers([pair] as any)];
});
show("name grows init", () => {
  const init: any[] = [];
  const seed: any[] = [];
  seed.push("a");
  seed.push("1");
  init.push(seed);
  init[0][0] = { toString() { init.push(["b", "2"]); return "a"; } };
  return [...new Headers(init as any)];
});
show("name replaces value", () => {
  const pair: any[] = [];
  pair.push("a");
  pair.push("1");
  pair[0] = { toString() { pair[1] = "9"; return "a"; } };
  return [...new Headers([pair] as any)];
});
show("name shrinks pair", () => {
  const pair: any[] = [];
  pair.push("a");
  pair.push("1");
  pair[0] = { toString() { pair.pop(); return "a"; } };
  return [...new Headers([pair] as any)];
});
show("name grows pair a lot", () => {
  const pair: any[] = [];
  pair.push("a");
  pair.push("1");
  pair[0] = {
    toString() {
      for (let i = 0; i < 100; i++) pair.push("z");
      return "a";
    },
  };
  return [...new Headers([pair] as any)];
});
show("empty pair", () => [...new Headers([[]] as any)]);
show("one member", () => [...new Headers([["a"]] as any)]);
