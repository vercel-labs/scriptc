// Static fs/promises.open and FileHandle: defaults, shared close state,
// current-offset/positioned reads and writes, whole-file operations, stat,
// Buffer identity in result records, and rejection behavior.
import * as fs from "node:fs";
import { open } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const scratch = path.join(os.tmpdir(), `scr-2686-${process.pid}.txt`);
const missing = path.join(os.tmpdir(), `scr-2686-missing-${process.pid}.txt`);
fs.writeFileSync(scratch, "abcdef");

function optionalFlags(): string | undefined {
  return process.pid < 0 ? "r" : undefined;
}

function optionalMode(): number | undefined {
  return process.pid < 0 ? 0o600 : undefined;
}

function optionalNumber(): number | null | undefined {
  if (process.pid < 0) return 1;
  return process.pid === 0 ? null : undefined;
}

function optionalUtf8(): "utf8" | undefined {
  return process.pid < 0 ? "utf8" : undefined;
}

async function invalidFlags(flags: string): Promise<void> {
  try {
    await open(scratch, flags);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("invalid flags:", flags.length, err.name, err.code, JSON.stringify(err.message));
  }
}

async function invalidPath(value: string): Promise<void> {
  try {
    const unexpected = await open(value);
    await unexpected.close();
    console.log("invalid path: opened");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(
      "invalid path:",
      err.name,
      err.code,
      err.message.includes("without null bytes"),
      err.message.includes("\\x00suffix"),
    );
  }
}

async function invalidMode(mode: number): Promise<void> {
  try {
    await open(scratch, "r", mode);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("invalid mode:", mode, err.name, err.code);
  }
}

async function main(): Promise<void> {
  const handle = await open(scratch, "r+");
  const alias = handle;
  console.log("open:", handle.fd >= 0, alias.fd === handle.fd);

  const first = Buffer.alloc(3);
  const firstResult = await handle.read(first);
  console.log("read current:", firstResult.bytesRead, firstResult.buffer === first, first.toString());

  const positioned = Buffer.alloc(2);
  const positionedResult = await handle.read(positioned, 0, 2, 4);
  console.log("read positioned:", positionedResult.bytesRead, positioned.toString());

  const stringResult = await handle.write("XY");
  console.log("write string:", stringResult.bytesWritten, stringResult.buffer);
  const source = Buffer.from("QZ");
  const bytesResult = await handle.write(source, 0, 2, 1);
  console.log("write bytes:", bytesResult.bytesWritten, bytesResult.buffer === source);

  console.log("readFile current:", await handle.readFile("utf8"));
  const stats = await handle.stat();
  console.log("stat:", stats.isFile(), stats.size);

  await alias.close();
  console.log("closed:", handle.fd, alias.fd);
  await handle.close();
  console.log("closed twice:", handle.fd);
  try {
    await handle.readFile("utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("closed rejection:", err.name, err.code, err.message);
  }

  const writer = await fs.promises.open(scratch, "w+");
  await writer.writeFile("hello", "utf-8");
  await writer.appendFile(Buffer.from("!"));
  const all = Buffer.alloc(6);
  const allResult = await writer.read(all, null, null, 0);
  console.log("whole writes:", allResult.bytesRead, all.toString());
  const emptyWrite = await writer.write("", optionalNumber(), optionalUtf8());
  await writer.writeFile("", optionalUtf8());
  await writer.appendFile(Buffer.alloc(0), undefined);
  const emptyRead = await writer.readFile(undefined);
  console.log("undefined methods:", emptyWrite.bytesWritten, emptyRead.length);
  try {
    await writer.read(Buffer.alloc(1), 0, -1, 0);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("explicit length:", err.name, err.code);
  }
  await writer.close();

  const emptyEdges = await open(scratch, "r");
  const emptyBuffer = Buffer.alloc(0);
  const emptyDefaultWrite = await emptyEdges.write(emptyBuffer);
  const emptyInvalidWindowWrite = await emptyEdges.write(emptyBuffer, -1, 1, 0);
  console.log(
    "empty Buffer writes:",
    emptyDefaultWrite.bytesWritten,
    emptyDefaultWrite.buffer === emptyBuffer,
    emptyInvalidWindowWrite.bytesWritten,
  );
  try {
    await emptyEdges.read(emptyBuffer, 0, 1, 0);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("empty Buffer read:", err.name, err.code, err.message);
  }
  await emptyEdges.close();

  const writeOnly = await open(scratch, "a");
  try {
    await writeOnly.readFile();
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("readFile bytes rejection:", err.name, err.code, err.message);
  }
  try {
    await writeOnly.readFile("utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("readFile string rejection:", err.name, err.code, err.message);
  }
  await writeOnly.close();

  const defaults = await open(scratch);
  const bytes = await defaults.readFile();
  console.log("defaults:", bytes.toString(), defaults.fd >= 0);
  await defaults.close();

  const explicitDefaults = await open(scratch, undefined, undefined);
  console.log("explicit defaults:", explicitDefaults.fd >= 0);
  await explicitDefaults.close();

  const optionalDefaults = await open(scratch, optionalFlags(), optionalMode());
  const optionalBuffer = Buffer.alloc(2);
  const optionalRead = await optionalDefaults.read(
    optionalBuffer,
    optionalNumber(),
    optionalNumber(),
    optionalNumber(),
  );
  console.log("optional defaults:", optionalRead.bytesRead, optionalBuffer.toString());
  await optionalDefaults.close();

  await invalidFlags("bad");
  await invalidFlags("w'bad");
  await invalidFlags('w"bad');
  await invalidFlags("w'\"bad");
  await invalidFlags("w\\bad");
  await invalidFlags("w\nbad");
  await invalidFlags("w\u0080bad");
  await invalidFlags("w\0not-a-flag");
  await invalidFlags("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  await invalidPath(`${scratch}\0suffix`);
  await invalidMode(-1);
  await invalidMode(1.5);

  try {
    await open(missing);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("open rejection:", err.name, err.code);
  }

  fs.unlinkSync(scratch);
}

void main();
