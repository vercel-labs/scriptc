// Indexed reads of a string past 16 MiB answer from the same caches as
// smaller ones. The text is mixed ASCII, two-byte and astral characters, so
// a unit offset and a byte offset differ everywhere in it.
const piece = "éa😀"; // 7 bytes, 4 UTF-16 units
const text = piece.repeat(2_500_000); // 17.5 MB, 10,000,000 units
const last = text.length - 1;

let codes = 0;
for (const at of [0, 1, 2, 3, 4, 6, 7, 1_000_003, 5_000_002, last - 3, last])
  codes = (codes * 31 + text.charCodeAt(at)) % 1000000007;

// A dense scan converts the whole text; the strided one leaves it walking.
let dense = 0;
for (let i = 0; i < 1_500_000; i += 1) dense = (dense * 7 + text.charCodeAt(i)) % 1000000007;
let strided = 0;
for (let i = 0; i < 10_000_000; i += 17)
  strided = (strided * 11 + text.charCodeAt(i)) % 1000000007;

const middle = 5_000_000;
const spans = [
  text.slice(middle, middle + 5).length,
  text.substring(middle + 1, middle + 9).length,
  text.slice(-5).length,
  text.slice(2, 3),
].join(",");

console.log(text.length, last, codes, dense, strided, spans);
console.log(
  text.charCodeAt(middle + 2),
  text.charCodeAt(middle + 3),
  text.indexOf("😀é", middle),
  text.lastIndexOf("a", 900_000),
  text.includes("éa😀", middle + 3),
);
