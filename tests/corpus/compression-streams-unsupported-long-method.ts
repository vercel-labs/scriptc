// An unsupported compression-stream method names the callee in Node's
// TypeError, however long its spelling is: the message holds the whole text.
const stream = new CompressionStream("gzip");
const s: any = stream;
try {
  s.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa();
} catch (error) {
  const e = error as Error;
  console.log(e.name, e.message);
}
