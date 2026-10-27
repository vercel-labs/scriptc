// read(size) above the 64 KiB read-ahead mark: 'readable' keeps firing as
// input arrives until the requested size is buffered.
const input = process.stdin;
const sizes = [];
input.on('readable', () => {
  let chunk;
  while ((chunk = input.read(150000)) !== null) sizes.push(chunk.length);
});
input.on('end', () => console.log(sizes.join(',')));
