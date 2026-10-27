// for-in over a string-keyed dictionary visits the keys present when the
// walk starts, in insertion order, and skips a key deleted before its
// turn; keys added during the walk are not visited. A key deleted and
// added again before its turn is visited.
const d: Record<string, number> = {};
for (let i = 0; i < 8; i++) d["k" + i] = i;
const seen: string[] = [];
for (const key in d) {
  seen.push(key);
  if (key === "k1") {
    delete d["k3"];
    delete d["k0"];
    d["k8"] = 8;
  }
  if (key === "k2") {
    delete d["k5"];
    d["k5"] = 50;
  }
  if (key === "k4") delete d["k4"];
}
console.log(seen.join(","));
console.log(Object.keys(d).join(","), JSON.stringify(d));

// A numeric-looking key is walked in integer order before string keys.
const n: Record<string, string> = {};
n["b"] = "x";
n["2"] = "y";
n["10"] = "z";
n["a"] = "w";
const order: string[] = [];
for (const key in n) {
  order.push(key);
  if (key === "2") delete n["a"];
}
console.log(order.join(","));

// A larger dictionary walked many times.
const big: Record<string, number> = {};
for (let i = 0; i < 3000; i++) big["e" + i] = i;
let total = 0;
for (let pass = 0; pass < 20; pass++) for (const key in big) total += big[key]!;
console.log(total);
