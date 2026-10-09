// console and process stream writes across line sizes: short lines, lines
// around the runtime's 2 KiB on-stack line buffer, a single large string
// (written without a copy), many-argument lines, and lines larger than the
// 64 KiB stdio buffer. Each line must reach stdout/stderr byte-exactly and
// in source order, with every argument shape (strings, numbers including -0,
// NaN and exponents, booleans, empty strings, multi-byte UTF-8).
function repeat(unit: string, count: number): string {
  let out = "";
  for (let i = 0; i < count; i++) out += unit;
  return out;
}

const sizes = [0, 1, 2046, 2047, 2048, 2049, 4096, 65535, 65536, 65537, 200000];
for (const size of sizes) {
  const line = repeat("x", size);
  console.log(line);
  console.log(size, line.length, line.slice(0, 8));
  console.error(line);
}

// Near the stack boundary with numbers: the capacity bound reserves room for
// the longest number spellings.
const pad = repeat("p", 2000);
console.log(pad, -1.2345678901234567e-308, 1.7976931348623157e308, -0, NaN, -Infinity, 123456789012345680000);
console.log(pad, true, false, "", 0.1 + 0.2, 2 ** 53, -(2 ** 53));
console.error(pad, -0, 1e21, 5e-7, "tail");

// Multi-byte UTF-8 across the boundary: the byte length, not the UTF-16
// length, decides the buffer size.
const wide = repeat("\u00e9\u{1f9e8}", 700);
console.log(wide);
console.log("wide", wide, wide.length);
console.error(wide, "!");

// Many arguments in one line.
console.log("a", "b", 1, 2, true, "", "", -0, 3.5, "z", 1e-7, "end");
console.log();
console.error();

// Raw stream writes: empty, tiny, and large chunks interleaved with lines.
process.stdout.write("");
process.stdout.write("raw|");
console.log("after raw");
process.stdout.write(repeat("r", 70000) + "\n");
process.stderr.write("");
process.stderr.write(repeat("e", 3000) + "\n");
console.log("done", sizes.length);
