// Static process stdout/stderr writes: BufferEncoding arguments affect
// strings, are ignored for byte chunks, and completion callbacks run later
// with Node's success `null`. Argument effects still precede submission.

function chunk(): string {
  console.log("data-expression");
  return "7374617469632d656e636f6465647c";
}

function encoding(): "hex" {
  console.log("encoding-expression");
  return "hex";
}

function completion(label: string): (error?: Error | null) => number {
  console.log(`callback-expression:${label}`);
  return (error) => {
    console.log(`callback:${label}:${error === null}`);
    return 1; // Writable.write ignores completion callback results.
  };
}

function omitted(label: string): undefined {
  console.log(`omitted-expression:${label}`);
  return undefined;
}

process.stdout.write("literal-two-undefined|", undefined);
process.stdout.write("literal-three-undefined|", "utf8", undefined);
process.stdout.write("effect-two-undefined|", omitted("encoding"));
process.stdout.write("effect-three-undefined|", "utf8", omitted("callback"));
process.stdout.write(Buffer.from("byte-two-undefined|"), omitted("byte-encoding"));
process.stdout.write(Buffer.from("byte-three-undefined|"), "utf8", omitted("byte-callback"));

const encoded = process.stdout.write(chunk(), encoding(), completion("encoded"));
console.log("encoded-return", encoded);

process.stdout.write("ZGVmYXVsdHxlbmNvZGluZ3w=", "base64");
process.stdout.write("é|", "binary");
process.stdout.write(Buffer.from("buffer|"), "utf16le", completion("buffer"));
process.stdout.write("default|", completion("default"));
process.stdout.write("zero|", () => console.log("callback:zero"));

Promise.resolve().then(() => console.log("promise"));
process.nextTick(() => console.log("tick"));
console.log("body-done");

process.stderr.write("stderr-body|", "utf8", (error) => {
  process.stderr.write(`stderr-callback:${error === null}\n`);
});
