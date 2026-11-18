// FileHandle.readFile, writeFile and appendFile take an encoding name or an
// options record: the name selects the codec (every BufferEncoding), a null
// encoding answers the bytes, and `flag`/`mode` are read and ignored over an
// already-open handle. The handle is checked before the options, so a closed
// handle answers EBADF however malformed the record is.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "filehandle-data-"));
const file = join(dir, "data.txt");
const out = join(dir, "out.txt");
fs.writeFileSync(file, "hello");

// A runtime encoding name: the member's type says BufferEncoding, while the
// value only reaches the runtime, which validates and rejects it.
const badName = "zzz" as BufferEncoding;

async function report(label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    const value = await action();
    console.log(label, JSON.stringify(value === undefined ? "ok" : value));
  } catch (error) {
    const err = error as Error & { code?: string };
    console.log(label, JSON.stringify([err.code ?? null, err.message.split(dir).join("<dir>")]));
  }
}

async function main(): Promise<void> {
  const h = await fsp.open(file, "r");
  await report("readFile", async () => String(await h.readFile()));
  await report("readFile utf8", () => h.readFile("utf8"));
  await report("readFile record", () => h.readFile({ encoding: "utf8" }));
  await report("readFile base64", () => h.readFile({ encoding: "base64" }));
  await report("readFile hex", () => h.readFile("hex"));
  await report("readFile null", async () => Buffer.isBuffer(await h.readFile({ encoding: null })));
  await report("readFile flag", async () => String(await h.readFile({ flag: "zz" })));
  await report("readFile bad encoding", () => h.readFile({ encoding: badName }));
  await h.close();
  await report("closed readFile", () => h.readFile({ encoding: badName }));
  await report("closed writeFile", () => h.appendFile("x"));

  const w = await fsp.open(out, "w");
  await report("writeFile bare", async () => {
    await w.writeFile("plain");
  });
  await report("writeFile utf8", async () => {
    await w.writeFile("utf8", "utf8");
  });
  await report("writeFile base64", async () => {
    await w.writeFile("aGk=", { encoding: "base64" });
  });
  await report("writeFile ignored", async () => {
    await w.writeFile("z", { mode: 0o600, flag: "zz" });
  });
  await report("writeFile bad encoding", () => w.writeFile("x", { encoding: badName }));
  await report("appendFile record", async () => {
    await w.appendFile("Q", { encoding: "utf8" });
  });
  await report("appendFile base64", async () => {
    await w.appendFile("aGk=", { encoding: "base64" });
  });
  // Data whose static type is the string | Buffer union takes the
  // checked-dynamic path, where the encoding must still encode the string.
  const unionData: string | Buffer = "aGk=";
  await report("writeFile dyn base64", async () => {
    await w.writeFile(unionData, { encoding: "base64" });
  });
  await report("appendFile dyn hex", async () => {
    await w.appendFile(unionData, { encoding: "hex" });
  });
  // A nullish encoding names the default, and its expression still runs.
  let encodingCalls = 0;
  const nullishEncoding = (): "utf8" | null => {
    encodingCalls++;
    return null;
  };
  await report("writeFile nullish", async () => {
    await w.writeFile("Q", { encoding: nullishEncoding() });
  });
  await report("nullish ran", async () => encodingCalls);
  await w.close();
  console.log("written", JSON.stringify(fs.readFileSync(out, "utf8")));

  // FileHandle.chown: fchown on the descriptor, with the ids the fs chown
  // ladder accepts (-1 leaves the owner alone) and its rejections.
  const c = await fsp.open(out, "r");
  await report("chown -1", async () => {
    await c.chown(-1, -1);
  });
  await report("chown uid", () => c.chown(1.5, 0));
  await report("chown gid", () => c.chown(0, -2));
  await c.close();
  await report("chown closed", () => c.chown(0, 0));

  fs.rmSync(dir, { recursive: true, force: true });
}

await main();
