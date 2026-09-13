// For-of over a typed number[][] carries the state-aware array value type;
// new Uint8Array accepts the undefined arm as Node's zero-length source.
const vectors: number[][] = [[65, 66], [67]];
const decoder = new TextDecoder();
for (const vector of vectors) {
  const bytes = new Uint8Array(vector);
  console.log(decoder.decode(bytes));
}
