// A once('readable') listener that reads part of the input: the rest stays
// buffered for a 'data' listener added afterwards.
const input = process.stdin;
input.once('readable', () => {
  const head = input.read(3);
  console.log('head', head === null ? null : head.toString('ascii'));
  setTimeout(() => {
    const rest = [];
    input.on('data', (chunk) => rest.push(chunk.toString('ascii')));
    input.on('end', () => console.log('rest', rest.join('')));
  }, 50);
});
