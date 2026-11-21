// A JSON builder that grows past 4 MiB: the allocator moves the string's run
// to a larger one, and a failed move must map the new range again before it
// copies into it. A SIGSEGV here is the run move's fallback writing into the
// range a failed MREMAP_FIXED unmapped.

const lines: string[] = [];
for (let i = 0; i < 1760; i++) lines.push("x".repeat(2400));
const text = JSON.stringify(lines);
console.log(String(text.length));
console.log(text.slice(0, 8));
