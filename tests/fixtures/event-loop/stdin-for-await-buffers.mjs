// for await over process.stdin yields Buffers: Buffer.isBuffer holds and
// indexOf takes a byte and a start offset (only chunking-independent facts
// are printed).
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
console.log('buffers', chunks.every((chunk) => Buffer.isBuffer(chunk)));
const all = Buffer.concat(chunks);
const newlines = [];
for (let at = all.indexOf(10); at !== -1; at = all.indexOf(10, at + 1)) newlines.push(at);
console.log('newlines', newlines.join(','), all.subarray(newlines[0] + 1).indexOf('#'));
