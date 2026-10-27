// Buffer indexOf, lastIndexOf and includes with needles whose first byte
// recurs: a candidate whose later bytes differ is skipped, matches at the
// first and last positions are found, byteOffset clamps and counts from the
// end, and the search reads only the buffer's own window of its memory.
const text = Buffer.from("aab aaab aaaab ab\nab");
console.log(text.indexOf("ab"), text.indexOf("aab"), text.indexOf("aaab"), text.indexOf("aaaab"), text.indexOf("aaaaab"));
console.log(text.lastIndexOf("ab"), text.lastIndexOf("aab"), text.lastIndexOf("aaab"), text.lastIndexOf("b\na"));
console.log(text.indexOf("ab", 2), text.indexOf("ab", -3), text.indexOf("ab", 100), text.indexOf("ab", -100));
console.log(text.lastIndexOf("ab", 5), text.lastIndexOf("ab", -4), text.lastIndexOf("ab", 0), text.lastIndexOf("aa", 1));
console.log(text.indexOf(10), text.indexOf(97, 3), text.lastIndexOf(98), text.lastIndexOf(97, -2), text.includes("b a"));
console.log(text.indexOf(""), text.indexOf("", 4), text.indexOf("", 100), text.lastIndexOf(""), text.indexOf("x"));
console.log(text.indexOf(Buffer.from("a\nab")), text.indexOf("ab\nab"), text.indexOf("ab\nabc"), text.lastIndexOf("aab", 4));

// A window into a larger buffer never sees the bytes outside it.
const whole = Buffer.from("xxneedlexx needle needlexx");
const window = whole.subarray(3, 22);
console.log(window.toString(), window.indexOf("needle"), window.lastIndexOf("needle"), window.indexOf("xx"), window.includes("xne"));
console.log(window.indexOf("eedle", 1), window.lastIndexOf("eed"), window.indexOf("needlex"), window.lastIndexOf("n", 0));

// A long search with many first-byte candidates.
const long = Buffer.alloc(20000, "ab");
long.write("abc", 19990);
console.log(long.indexOf("abc"), long.lastIndexOf("aba"), long.indexOf("abc", 19991), long.lastIndexOf("abc"), long.indexOf("bb"));
const lines: number[] = [];
const fasta = Buffer.from(">ONE\nACGT\nTTGA\n>TWO\nGGCC\n");
for (let at = fasta.indexOf(10); at !== -1; at = fasta.indexOf(10, at + 1)) lines.push(at);
console.log(lines.join(","), fasta.indexOf(62, 1), fasta.lastIndexOf(62));
