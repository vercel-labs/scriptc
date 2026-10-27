// A typed array that untyped code pushes several values onto at once: the
// values append to the same array, which the typed code then reads.
const chunks: string[] = ["<a"];
const sink: any = chunks;
function pushPair(target: any, a: any, b: any): number {
  return target.push(a, b);
}
console.log(sink.push(" ", "b=", "1"), chunks.join(""), chunks.length);
console.log(pushPair(sink, ">", "</a>"), chunks.join(""), chunks[chunks.length - 1]);
const numbers: number[] = [1];
const loose: any = numbers;
for (let i = 0; i < 3; i++) loose.push(i, i * 10);
console.log(numbers.join(","), numbers.length);
