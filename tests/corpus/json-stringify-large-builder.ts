// A JSON text that grows past 4 MiB: the builder's runs move to larger
// mappings while it grows, and the finished text is read back whole.
const lines: string[] = [];
for (let i = 0; i < 1760; i++) lines.push("x".repeat(2400));
const text = JSON.stringify(lines);
console.log(String(text.length));
console.log(text.slice(0, 8));
console.log(text.slice(-9));
