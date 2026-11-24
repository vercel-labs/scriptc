// Readable.from's encoding option, written with the stream's static types:
// the readable's decoder decodes Buffer chunks and leaves string chunks,
// and a spelling Node does not know throws ERR_UNKNOWN_ENCODING.
import { Readable } from "node:stream";

const show = async (label: string, stream: Readable): Promise<void> => {
  const out: string[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: string | Buffer) =>
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

await show("typed buffers hex", Readable.from([Buffer.from("ab"), Buffer.from("cd")], { encoding: "hex" }));
await show("typed strings hex", Readable.from(["ab"], { encoding: "hex" }));
await show(
  "typed byte mode",
  Readable.from([Buffer.from("ab")], { objectMode: false, encoding: "base64" }),
);
await show("typed utf-8 spelling", Readable.from([Buffer.from("ab")], { encoding: "utf-8" }));
await show("typed undefined encoding", Readable.from([Buffer.from("ab")], { encoding: undefined }));

try {
  Readable.from([], { encoding: "nope" });
  console.log("typed bad accepted");
} catch (error) {
  const e = error as { code?: string; message: string };
  console.log(`typed bad ${e.code} ${e.message}`);
}

// An initializer whose type is a literal is still evaluated: its side
// effects run once, in the call's argument order (the source first), and
// its throws reach the caller.
const log: string[] = [];
const pick = (): "utf8" => {
  log.push("pick");
  return "utf8";
};
const boom = (): "utf8" => {
  log.push("boom");
  throw new Error("bad encoding");
};
const source = (): Buffer[] => {
  log.push("source");
  return [Buffer.from("ab")];
};
await show("typed effect", Readable.from(source(), { encoding: pick() }));
console.log("typed effects", log.join(","));

try {
  Readable.from([Buffer.from("ab")], { encoding: boom() });
  console.log("typed throw lost");
} catch (error) {
  console.log(`typed throw kept ${(error as Error).message} ${log.join(",")}`);
}

// A const bound to a literal folds without a runtime check.
const spelled = "hex";
await show("typed const", Readable.from([Buffer.from("ab")], { encoding: spelled }));

// An invalid runtime encoding throws where the call is: the caller's catch
// sees Node's error and execution continues normally.
const bad = (): string => "nope";
try {
  Readable.from([Buffer.from("ab")], { encoding: bad() });
  console.log("typed catch missed");
} catch (error) {
  const e = error as { code?: string; message: string };
  console.log(`typed catch ${e.code} ${e.message}`);
}
console.log("typed after");
