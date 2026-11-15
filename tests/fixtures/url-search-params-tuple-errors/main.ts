// A sequence row's name converts before its value does. When the value
// conversion throws, the name that had already been converted must not stay
// allocated; the loop repeats the failing construction so a leak adds up.
function heapKb(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024);
}

const name = {
  toString(): string {
    return "x".repeat(64 * 1024);
  },
};
const rounds = 300;
let baseline = 0;
let threw = 0;
for (let i = 0; i < rounds; i++) {
  try {
    new URLSearchParams([[name, { toString: null }] as any] as any);
  } catch {
    threw++;
  }
  if (i === 100) baseline = heapKb();
}
console.log("growth", heapKb() - baseline);
console.log("threw", threw);
