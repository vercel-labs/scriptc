// process.stdin in paused mode through 'readable': each event drains the
// buffer with read(), one more event follows EOF, and 'end' comes after the
// read that finds the buffer empty.
const input = process.stdin;
const events = [];
let text = '';
input.on('readable', () => {
  let reads = 0;
  let chunk;
  while ((chunk = input.read()) !== null) {
    text += String(chunk);
    reads++;
  }
  events.push(`readable ${reads}`);
});
input.on('end', () => {
  console.log(events.join(', '));
  console.log(JSON.stringify(text), input.readableLength);
});
