// Untyped JavaScript calling builtin methods on values it never declares
// types for: string slice/indexOf/toUpperCase/startsWith/padStart, array
// push/pop/at/join/includes/indexOf, Map and Set get/set/has/add, number
// toFixed, and calls of an object's own methods. Argument: the number of
// iterations.
const rounds = Number(process.argv[2] ?? "300000");
const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
const counts = new Map();
const seen = new Set();
const stack = [];
const recent = [];
const tally = {
  total: 0,
  add(value) {
    this.total += value;
    return this.total;
  },
};
let checksum = 0;
for (let i = 0; i < rounds; i++) {
  const word = words[i % words.length];
  const head = word.slice(0, 3).toUpperCase();
  const key = head.padStart(4, "-");
  if (word.indexOf("e") >= 0 && !word.startsWith("z")) checksum += 1;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  seen.add(i % 97);
  if (seen.has(i % 89)) checksum += 2;
  stack.push(i);
  if (stack.length > 32) checksum += stack.pop() % 3;
  recent.push(word);
  if (recent.length > 4) recent.shift();
  if (recent.includes("gamma")) checksum += recent.indexOf("gamma");
  checksum += tally.add(i % 5) % 11;
  if (i % 1000 === 0) checksum += Number((i / 7).toFixed(2)) | 0;
}
console.log(checksum, counts.size, seen.size, stack.at(-1), recent.join(","), tally.total);
