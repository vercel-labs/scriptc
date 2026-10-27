// indexOf with a start index on ASCII receivers: integral, fractional,
// negative, -0, NaN, Infinity and out-of-range starts; empty needles, which
// are found at the clamped start; needles longer than the rest; needles with
// non-ASCII characters and lone surrogates, which an ASCII receiver never
// contains; and receivers built at run time (slices, concatenations, readline
// style splits) next to non-ASCII ones. The results match Node's.
const line = `10.1.2.3 - - [24/Oct/2026:10:00:00 +0000] "GET /api/items/7?page=3 HTTP/1.1" 200 5120 "agent"`;
const starts = [0, 1, 2.7, -1, -0, NaN, Infinity, -Infinity, line.length - 1, line.length, line.length + 5, 1e21];
const needles = ["", '"', " ", "/", "api", "HTTP/1.1", line, line + "x", "é", "\ud83d", "\udca9", "💩"];

for (const needle of needles) {
  const found = starts.map((start) => line.indexOf(needle, start));
  console.log(JSON.stringify(needle), found.join(" "));
}

const quote = line.indexOf('"');
const space = line.indexOf(" ", quote);
const path = line.slice(space + 1, line.indexOf("/", line.indexOf("/", space) + 1));
const close = line.indexOf('"', space);
console.log(quote, space, path, close, line.slice(close + 2, close + 5));

const built = ["alpha", "beta", "gamma"].join("/") + "/" + String(42);
for (let i = 0; i <= built.length + 1; i++) {
  console.log(i, built.indexOf("/", i), built.indexOf("a", i), built.indexOf("", i), built.indexOf("42", i));
}

const mixed = "café/naïve/ascii/end";
const ascii = mixed.slice(mixed.indexOf("ascii"));
console.log(ascii, ascii.indexOf("/", 1), ascii.indexOf("end", 3), mixed.indexOf("/", 5), mixed.indexOf("ascii", 6));

let count = 0;
let at = 0;
const csv = Array.from({ length: 200 }, (_, i) => `${i},${i * 3},row${i}`).join(",");
while ((at = csv.indexOf(",", at)) !== -1) {
  count++;
  at += 1.5;
}
console.log("commas", count);
