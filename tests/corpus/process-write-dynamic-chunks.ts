// process.stdout/stderr.write of chunks whose type is only known at run
// time: `any` values (a child's 'data' chunk, a JSON field) and
// string | Uint8Array unions. Strings and Uint8Array/Buffer values write
// their bytes; null throws ERR_STREAM_NULL_VALUES and any other value
// throws ERR_INVALID_ARG_TYPE, both TypeErrors raised synchronously before
// anything is written.

function forward(data: any): boolean {
  return process.stdout.write(data);
}

function pick(useBytes: boolean): string | Uint8Array {
  return useBytes ? new Uint8Array([98, 121, 116, 101, 115, 10]) : "text\n";
}

console.log("string", forward("any string\n"));
console.log("buffer", forward(Buffer.from("any buffer\n")));
console.log("u8", forward(new TextEncoder().encode("any u8\n")));
process.stdout.write(pick(false));
process.stdout.write(pick(true));
process.stderr.write(pick(false));
const parsed: any = JSON.parse('{"chunk":"from json\\n","n":42}');
forward(parsed.chunk);

for (const bad of [parsed.n, null, undefined, { a: 1 }]) {
  try {
    forward(bad);
    console.log("no throw");
  } catch (error) {
    if (error instanceof TypeError) {
      console.log((error as NodeJS.ErrnoException).code, error.message);
    }
  }
}
