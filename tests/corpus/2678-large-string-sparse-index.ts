// Large mixed-Unicode indexed-string regression. The output is compact and
// deterministic; the runtime white-box test owns the complexity bound while
// this corpus pins C/LLVM semantics against Node.
const piece = "aé😀é"; // UTF-16 units: a, é, high/low 😀, e, combining mark
const text = piece.repeat(12000);
const positions = [0, 1, 2, 3, 4, 5, 6, 31111, 52799, text.length - 6];

let codes = 0;
let spans = "";
for (const p of positions) {
  codes = (codes * 131 + text.charCodeAt(p)) % 1000000007;
  spans += text.slice(p, p + 3).length + ",";
  spans += text.substring(p + 1, p + 4).length + ";";
}

const middle = Math.floor(text.length / 2 / 6) * 6;
console.log(text.length, codes, spans);
console.log(
  text.charCodeAt(middle + 2),
  text.charCodeAt(middle + 3),
  text.indexOf("é😀", middle),
  text.includes("😀e", middle + 1),
  text.lastIndexOf("😀"),
);
let iter = 0;
for (const ch of text.slice(middle, middle + 12)) iter = iter * 17 + ch.length;
console.log(iter, text.slice(-6).length, text.substring(2, 4).length);
