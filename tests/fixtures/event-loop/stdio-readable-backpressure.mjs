// 'readable', 'data' and resume() together, with no read() for a while:
// 'readable' keeps the stream paused, so it stops reading at its read-ahead
// mark until a read drains it, and 'data' sees what read() returns.
const input = process.stdin;
let draining = false;
let peak = 0;
let dataBytes = 0;
let readBytes = 0;
const drain = () => {
  let chunk;
  while ((chunk = input.read()) !== null) readBytes += chunk.length;
};
input.on('data', (chunk) => {
  dataBytes += chunk.length;
});
input.on('readable', () => {
  peak = Math.max(peak, input.readableLength);
  if (draining) drain();
});
input.resume();
setTimeout(() => {
  peak = Math.max(peak, input.readableLength);
  console.log('held below 128 KiB while not draining', peak <= 131072);
  draining = true;
  drain();
}, 400);
input.on('end', () => console.log('read', readBytes, 'data', dataBytes));
