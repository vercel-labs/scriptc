// With --small, the complete output fits below pipe capacity so Node's
// independent asynchronous stdout/stderr queues cannot interleave chunks.
// The default covers large writes to a shared file or separate pipes,
// including lines beyond the runtime's stack buffer and 64 KiB stdio buffer.
const large = process.argv[2] !== "--small";

function repeat(unit: string, count: number): string {
  let out = "";
  for (let i = 0; i < count; i++) out += unit;
  return out;
}

console.log("out 1");
console.error("err 1");
console.log("out", 2, true, -0);
console.warn("warn", 3, false);
process.stdout.write("raw-out|");
process.stderr.write("raw-err|");
console.log("after raws");
for (let i = 0; i < 50; i++) {
  if (i % 3 === 0) console.error("loop err", i);
  else console.log(`loop out ${i}`);
}
console.log(repeat("o", large ? 5000 : 50));
console.error(repeat("e", large ? 5000 : 50));
console.log("big", repeat("O", large ? 70000 : 100), 1);
console.error(repeat("E", large ? 70000 : 100));
process.stdout.write(repeat("w", large ? 3000 : 50));
process.stderr.write(repeat("v", large ? 3000 : 50) + "\n");
console.log("|end of sync");
setTimeout(() => {
  console.error("timer err");
  console.log("timer out");
  process.stdout.write("timer raw\n");
}, 1);
