// An asserted element read passed straight to a function (`decode(xs[i]!)`)
// compiles for every element type, in loops and nested calls. The assertion
// has no runtime effect: a missing element reaches the callee as undefined,
// which may skip it or throw Node's TypeError when it reads a member.

class Frame {
  bytes: number;
  constructor(bytes: number) {
    this.bytes = bytes;
  }
}

function decode(buffer: Uint8Array): number {
  return buffer.length;
}
function frameSize(frame: Frame): number {
  return frame.bytes;
}
function label(text: string): string {
  return `<${text}>`;
}
function bump(n: number): number {
  return n + 1;
}
function double(n: number): number {
  return n * 2;
}
function sizeIf(read: boolean, frame: Frame): number {
  return read ? frame.bytes : -1;
}
function lengthIf(read: boolean, buffer: Uint8Array): number {
  return read ? buffer.length : -1;
}

const buffers: Uint8Array[] = [new Uint8Array([1, 2]), new Uint8Array([3])];
const frames: Frame[] = [new Frame(10), new Frame(20)];
const words = "alpha beta".split(" ");
const counts = [4, 5];

console.log(decode(buffers[0]!), frameSize(frames[1]!), label(words[0]!), bump(counts[1]!));
let total = 0;
for (let i = 0; i < buffers.length; i++) total += decode(buffers[i]!);
for (let i = 0; i < frames.length; i++) total += frameSize(frames[i]!);
console.log(total);
console.log(double(decode(buffers[1]!)), double(frameSize(frames[0]!)), label(label(words[1]!)));

function sumFrames(list: Frame[]): number {
  let sum = 0;
  for (let i = 0; i < list.length; i++) sum += frameSize(list[i]!);
  return sum;
}
console.log(sumFrames(frames));

// Past the end: the callee receives undefined.
console.log(sizeIf(false, frames[5]!), lengthIf(false, buffers[7]!), bump(counts[9]!));
console.log(label(words[4]!));
try {
  console.log(frameSize(frames[3]!));
} catch (e) {
  console.log(e instanceof TypeError, (e as Error).message);
}
try {
  console.log(decode(buffers[3]!));
} catch (e) {
  console.log(e instanceof TypeError, (e as Error).message);
}
