// console.log/console.error with string concatenations whose later (glued)
// parts are long strings. The runtime sizes the line buffer from the parts
// before rendering them, so every glued string part must count with its full
// byte length: parts longer than 32 bytes, and lines that cross the runtime's
// 2 KiB on-stack line buffer, must print byte-exactly.
function repeat(unit: string, count: number): string {
  let out = "";
  for (let i = 0; i < count; i++) out += unit;
  return out;
}

const sizes = [31, 32, 33, 100, 2047, 2048, 2049, 5000, 70000];
for (const size of sizes) {
  const part = repeat("g", size);
  console.log(`<${part}>`);
  console.log("head:" + part + ":" + part + ":tail");
  console.error(`${size} ${part}|${part.length}`, size);
}

// Several long glued parts in one argument, next to plain arguments.
const a = repeat("a", 1500);
const b = repeat("b", 1500);
const c = repeat("c", 1500);
console.log(`${a}${b}${c}`, a.length + b.length + c.length);
console.log("x", `${a}-${b}`, "y", `[${c}]`, true);
console.error(a + b + c + a + b + c);

// A single argument that is a template: the first part is short, the glued
// part pushes the line past the stack buffer.
const big = repeat("z", 4096);
console.log(`=${big}`);
console.error(`=${big}`);

// Multi-byte UTF-8 glued parts: the byte length decides the buffer size.
const wide = repeat("\u00e9\u{1f9e8}", 600);
console.log(`wide:${wide}:${wide}`);
console.log(`${wide.length} ${wide}`, wide.length);

// Many long glued parts in a loop body.
for (let i = 0; i < 3; i++) {
  const p = repeat(String(i), 64 + i * 900);
  console.log(`#${i} ${p} ${p} ${i * 1.5}`);
}
