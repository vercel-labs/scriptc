// A write replacement installed through an untyped alias, which no
// assignment in the source names, still receives writes whose chunk type is
// known only at run time: an `any` value and a string | Uint8Array union,
// on stdout and on stderr.
function capture(stream: any, lines: string[]): () => void {
  const original = stream.write;
  stream.write = (chunk: unknown): boolean => {
    lines.push(typeof chunk === "string" ? chunk.trimEnd() : `<${(chunk as Uint8Array).length} bytes>`);
    return true;
  };
  return () => {
    stream.write = original;
  };
}

const out: string[] = [];
const err: string[] = [];
const releaseOut = capture(process.stdout, out);
const releaseErr = capture(process.stderr, err);
const untyped: any = JSON.parse('"untyped string\\n"');
const untypedBytes: any = Buffer.from("untyped bytes\n");
const either: string | Uint8Array = out.length === 0 ? "union string\n" : new Uint8Array(1);
process.stdout.write(untyped);
process.stdout.write(untypedBytes);
process.stdout.write(either);
process.stdout.write("literal string\n");
process.stdout.write(Buffer.from("typed bytes\n"));
process.stderr.write(untyped);
process.stderr.write(either);
console.log("console line");
releaseOut();
releaseErr();
// Released: the same chunks reach the descriptors.
process.stdout.write(untyped);
process.stderr.write(either);
console.log(JSON.stringify(out));
console.log(JSON.stringify(err));
