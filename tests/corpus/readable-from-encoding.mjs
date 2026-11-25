// Readable.from's encoding option is the readable state's decoder: Buffer
// chunks decode with it (a split multibyte sequence included), string
// chunks pass through, readableEncoding is the spelling, and a spelling
// Node does not know is its ERR_UNKNOWN_ENCODING at construction.
import { Readable } from "node:stream";

const show = async (label, stream) => {
  const out = [];
  await new Promise((resolve, reject) => {
    stream.on("data", (chunk) =>
      out.push(`${typeof chunk}:${Buffer.isBuffer(chunk) ? chunk.toString() : chunk}`),
    );
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  console.log(
    label,
    stream.readableObjectMode,
    stream.readableHighWaterMark,
    JSON.stringify(stream.readableEncoding),
    out.join(","),
  );
};

await show("strings hex", Readable.from(["ab"], { encoding: "hex" }));
await show(
  "buffers hex",
  Readable.from([Buffer.from("ab"), Buffer.from("cd")], { encoding: "hex" }),
);
await show(
  "utf8 split",
  Readable.from([Buffer.from([0xe2, 0x82]), Buffer.from([0xac])], { encoding: "utf8" }),
);
await show(
  "byte mode hex",
  Readable.from([Buffer.from("ab")], { objectMode: false, encoding: "hex" }),
);
await show("single buffer utf8", Readable.from(Buffer.from("xy"), { encoding: "utf8" }));
await show(
  "hwm base64",
  Readable.from([Buffer.from("ab")], { highWaterMark: 3, encoding: "base64" }),
);
await show("utf-8 spelling", Readable.from([Buffer.from("ab")], { encoding: "utf-8" }));

// A variable options object and its runtime encoding value.
{
  const options = { encoding: "hex", highWaterMark: 2 };
  await show("dynamic options", Readable.from([Buffer.from("ab")], options));
}

// A web ReadableStream source decodes the same way.
{
  const web = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("ab"));
      controller.close();
    },
  });
  await show("web source hex", Readable.from(web, { encoding: "hex" }));
}

// An explicitly falsy encoding leaves the readable undecoded, as Node's
// state constructor does; a truthy non-string is coerced and validated.
for (const encoding of [undefined, null, "", false, 0, NaN]) {
  await show(`falsy ${String(encoding)}`, Readable.from([Buffer.from("ab")], { encoding }));
}
{
  const encoding = "";
  await show("falsy variable", Readable.from([Buffer.from("ab")], { encoding }));
}

// An invalid runtime encoding throws where the call is: the catch sees it
// and execution continues.
const badEncoding = () => "nope";
try {
  Readable.from([Buffer.from("ab")], { encoding: badEncoding() });
  console.log("runtime catch missed");
} catch (error) {
  console.log(`runtime catch ${error.code} ${error.message}`);
}
console.log("runtime after");

// A spelling Node does not know, whatever its type, is its runtime throw.
for (const encoding of ["nope", 5]) {
  try {
    Readable.from([], { encoding });
    console.log(`bad ${JSON.stringify(encoding)} accepted`);
  } catch (error) {
    console.log(`bad ${JSON.stringify(encoding)} ${error.code} ${error.message}`);
  }
}
