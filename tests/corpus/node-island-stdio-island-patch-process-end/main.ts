// @requires-libnode
// A process.stdout.write replacement installed by island code, in a program
// whose native code holds the stream but never replaces its write method:
// native writes of a chunk known only at run time reach the replacement,
// and so does the output of a native 'exit' listener, with the stream as
// the replacement's receiver. The program keeps no module-level values, so
// its 'exit' listeners run at process end rather than from main.
import { callSync } from "@scriptc/node";

function main(): void {
  const out = process.stdout;
  console.log(`stdout fd ${out.fd}`);

  const chunks: (string | Uint8Array)[] = ["a string chunk\n", Buffer.from("a Buffer chunk\n")];
  const loose: unknown = "an unknown chunk\n";

  callSync("./capture.cjs", "install");
  for (const chunk of chunks) process.stdout.write(chunk);
  process.stdout.write(loose as string | Uint8Array);
  console.log("a console line");
  process.stderr.write(chunks[0]!);

  process.on("exit", (code) => {
    console.log("native exit listener", code);
    process.stdout.write(chunks[1]!);
  });
}

main();
