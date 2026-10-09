// `new RegExp(source, flags)` built repeatedly from the same pieces shares
// compiled bytecode between instances. Pins that each instance keeps its own
// lastIndex, that flags (in any spelling order) select distinct behavior,
// that invalid patterns throw every time, and that patterns past the cache
// budget or of long sources still behave.
const words = ["alpha", "beta", "gamma", "alpha", "delta", "Alpha"];
function matcher(word: string, flags: string): RegExp {
  return new RegExp("^" + word + "$", flags);
}
let hits = 0;
let ci = 0;
for (let i = 0; i < 20000; i++) {
  const w = words[i % words.length]!;
  if (matcher("alpha", "").test(w)) hits++;
  if (matcher("alpha", "i").test(w)) ci++;
}
console.log(hits, ci);

// Independent lastIndex per instance of the same pattern.
const g1 = new RegExp("\\d", "g");
const g2 = new RegExp("\\d", "g");
const subject = "a1b2c3";
g1.exec(subject);
g1.exec(subject);
console.log(g1.lastIndex, g2.lastIndex, g2.exec(subject)![0], g1.exec(subject)![0], g1.lastIndex);

// Flag spellings: "gi" and "ig" normalize to the same flags; "y" differs.
const a = new RegExp("x", "gi");
const b = new RegExp("x", "ig");
const y = new RegExp("x", "y");
console.log(a.flags, b.flags, a.test("aX"), b.test("aX"), y.test("ax"), y.lastIndex);

// Empty source, and the source/toString surface.
const empty = new RegExp("");
console.log(empty.source, String(empty), empty.test("anything"), new RegExp("a-b").source);

// Invalid patterns throw on every construction.
let thrown = 0;
for (let i = 0; i < 3; i++) {
  try {
    new RegExp("(unclosed", "g");
  } catch (e) {
    if (e instanceof SyntaxError) thrown++;
  }
}
console.log(thrown);

// More distinct patterns than the cache holds, then the first ones again.
let distinct = 0;
for (let i = 0; i < 600; i++) if (new RegExp("^n" + i + "$").test("n" + i)) distinct++;
for (let i = 0; i < 600; i += 100) if (new RegExp("^n" + i + "$").test("n" + i)) distinct++;
console.log(distinct);

// A long source.
const long = "(?:" + "ab|".repeat(600) + "zz)";
const longRe = new RegExp(long, "g");
console.log(long.length, "xxzzab".replace(longRe, "_"), new RegExp(long).test("zz"));

// Non-unicode astral source (CESU-8 re-encoding) through the cache twice.
for (let i = 0; i < 2; i++) console.log(new RegExp("😀+").test("a😀😀"), new RegExp("^.$", "u").test("😀"));
