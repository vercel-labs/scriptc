// Fixed-size reads of stdin: read(n) answers null until n bytes are
// buffered, and the rest once the input ended.
const input = process.stdin;
const chunks = [];
const counts = [];
input.on('readable', () => {
  let reads = 0;
  let chunk;
  while ((chunk = input.read(4)) !== null) {
    chunks.push(chunk.toString('ascii'));
    reads++;
  }
  counts.push(reads);
});
input.on('end', () => {
  console.log(chunks.join('|'));
  console.log(counts.join(','));
});
