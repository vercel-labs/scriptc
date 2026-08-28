// The surface-tail sweep trio: string.substring (clamp-and-swap, the
// port-suffix idiom), array findIndex (first match or -1, index-aware
// callbacks), and the comparator-less sort() on string[] (JS's default
// UTF-16 ordering — a dedicated comparator because relational operators use
// scriptc's documented code-point order).
const localAddr = "127.0.0.1.51823";
const lastColon = localAddr.lastIndexOf(".");
console.log(localAddr.substring(lastColon + 1));
console.log(parseInt(localAddr.substring(lastColon + 1), 10));

const s = "hello world";
console.log(s.substring(0, 5));
console.log(s.substring(5, 0));
console.log(s.substring(-3, 4));
console.log(s.substring(4));
console.log(s.substring(99));
console.log(s.substring(3, 99));
console.log(s.substring(2.9, 7.1));
console.log(s.substring(0 / 0, 5));
console.log("héllo wörld".substring(1, 4));

// findIndex — the proxy-start scan idiom (arg + lookahead by index).
const command = ["node", "cli.js", "proxy", "start", "--port", "443"];
const proxyIndex = command.findIndex(
  (arg, index) => arg === "proxy" && command[index + 1] === "start"
);
console.log(proxyIndex);
console.log(command.findIndex((arg) => arg === "nope"));
console.log([3, 1, 4, 1, 5].findIndex((n) => n < 2));
console.log(([] as string[]).findIndex((x) => x === ""));

// Comparator-less sort on string[]: stable, in-place, returns the array.
const included = new Set(["zeta", "alpha", "Beta", "beta", "10", "2", ""]);
console.log(JSON.stringify([...included].sort()));
const names = ["b", "a", "c", "a"];
const same = names.sort();
console.log(JSON.stringify(names), same === names);
console.log(JSON.stringify(["é", "e", "z", "Z"].sort()));
