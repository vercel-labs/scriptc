// The FileHandle member table: every read()/write() option shape Node
// accepts (including a nullish options value and the 16384-byte Buffer
// window Node allocates when no buffer is supplied), stat's option ladder
// with its null TypeError, the close/no-op/fd ladder, and the explicit
// async-dispose member. Only values the scratch file decides are printed.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fh-members-"));
const scratch = path.join(root, "scratch.bin");

function describe(value: Uint8Array): string {
  const shown = value.subarray(0, 10);
  let text = "";
  for (const byte of shown) text += byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".";
  return `${value.length}:${text}`;
}

async function failure<T>(label: string, run: () => Promise<T>): Promise<void> {
  try {
    await run();
    console.log(label, "no error");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, err.name, err.code ?? "-", err.message);
  }
}

async function readWindows(): Promise<void> {
  const handle = await fsp.open(scratch, "r");
  try {
    // No options at all: Node's default window is Buffer.alloc(16384) —
    // a real zero-filled Buffer, read from the current offset.
    const bare = await handle.read();
    console.log("default:", bare.bytesRead, describe(bare.buffer), Buffer.isBuffer(bare.buffer));

    // A nullish options value is the all-defaults record.
    const nulled = await handle.read(null);
    console.log("null options:", nulled.bytesRead, describe(nulled.buffer), Buffer.isBuffer(nulled.buffer));
    const undef = await handle.read(undefined);
    console.log("undefined options:", undef.bytesRead, describe(undef.buffer));

    // An empty literal carries no members.
    const empty = await handle.read({});
    console.log("empty options:", empty.bytesRead, describe(empty.buffer), Buffer.isBuffer(empty.buffer));

    const windowed = await handle.read({ offset: 1, length: 2, position: 3 });
    console.log("window:", windowed.bytesRead, describe(windowed.buffer));

    const target = Buffer.alloc(4, 0x2e);
    const into = await handle.read(target, {});
    console.log("buffer empty options:", into.bytesRead, into.buffer === target, describe(target));
    const offsetInto = await handle.read(target, { offset: 1, length: 2, position: 0 });
    console.log("buffer window:", offsetInto.bytesRead, describe(target));

    const supplied = Buffer.alloc(3, 0x2d);
    const given = await handle.read({ buffer: supplied });
    console.log("supplied buffer:", given.bytesRead, given.buffer === supplied, describe(supplied));
    const givenView = new Uint8Array(3);
    const view = await handle.read({ buffer: givenView });
    console.log("supplied view:", view.bytesRead, view.buffer === givenView, describe(Buffer.from(givenView)));
    const absentBuffer = await handle.read({ buffer: undefined, length: 2, position: 1 });
    console.log("absent buffer:", absentBuffer.bytesRead, describe(absentBuffer.buffer));

    // Stored options values: a record, and a value that may be nullish.
    const stored: fsp.FileReadOptions<Buffer> = { offset: 2, length: 1, position: 4 };
    const fromStored = await handle.read(stored);
    console.log("stored record:", fromStored.bytesRead, describe(fromStored.buffer));
    const maybe: fsp.FileReadOptions<Buffer> | null = null;
    const fromMaybe = await handle.read(maybe);
    console.log("stored null:", fromMaybe.bytesRead, describe(fromMaybe.buffer));
    function readWith(options: fsp.FileReadOptions<Buffer> | undefined): Promise<fsp.FileReadResult<Buffer>> {
      return handle.read(options);
    }
    console.log("parameter options:", (await readWith({ length: 2, position: 0 })).bytesRead);
    console.log("parameter undefined:", (await readWith(undefined)).bytesRead);
  } finally {
    await handle.close();
  }
}

async function writeWindows(): Promise<void> {
  fs.writeFileSync(scratch, "0123456789");
  const handle = await fsp.open(scratch, "r+");
  try {
    const plain = await handle.write(Buffer.from("ab"), {});
    console.log("write empty options:", plain.bytesWritten, plain.buffer.toString());
    const windowed = await handle.write(Buffer.from("cd"), { offset: 1, length: 1, position: 2 });
    console.log("write window:", windowed.bytesWritten, windowed.buffer.toString());
    const view = await handle.write(new Uint8Array([0x41]), {});
    console.log("write view:", view.bytesWritten, Buffer.from(view.buffer).toString());
    const stored: Omit<fsp.FileReadOptions<Buffer>, "buffer"> = { offset: 1, length: 2, position: 5 };
    const fromStored = await handle.write(Buffer.from("XYZ"), stored);
    console.log("write stored:", fromStored.bytesWritten);
    const asString = await handle.write("zz", 8, "utf8");
    console.log("write string:", asString.bytesWritten, asString.buffer);
  } finally {
    await handle.close();
  }
  console.log("file:", fs.readFileSync(scratch, "latin1"));
}

async function readFileForms(): Promise<void> {
  fs.writeFileSync(scratch, "0123456789");
  const fresh = async (
    label: string,
    run: (handle: fsp.FileHandle) => Promise<string | Buffer>,
  ): Promise<void> => {
    const handle = await fsp.open(scratch, "r");
    try {
      const value = await run(handle);
      if (typeof value === "string") console.log(label, "string", value);
      else console.log(label, "bytes", value.length, Buffer.isBuffer(value), value.toString("latin1"));
    } finally {
      await handle.close();
    }
  };
  // readFile reads from the current offset, so each form gets a fresh handle.
  await fresh("readFile none:", (h) => h.readFile());
  await fresh("readFile undefined:", (h) => h.readFile(undefined));
  await fresh("readFile null:", (h) => h.readFile(null));
  await fresh("readFile empty:", (h) => h.readFile({}));
  await fresh("readFile encoding null:", (h) => h.readFile({ encoding: null }));
  await fresh("readFile encoding undefined:", (h) => h.readFile({ encoding: undefined }));
  await fresh("readFile utf8:", (h) => h.readFile("utf8"));
  await fresh("readFile record utf8:", (h) => h.readFile({ encoding: "utf8" }));
  const handle = await fsp.open(scratch, "r");
  await failure("readFile unknown encoding:", () =>
    handle.readFile({ encoding: "buffer" as BufferEncoding }),
  );
  await handle.close();
  await failure("readFile closed:", () => handle.readFile());
  await failure("readFile closed null:", () => handle.readFile(null));
  await failure("readFile closed record:", () => handle.readFile({ encoding: "utf8" }));
}

async function statOptions(): Promise<void> {
  const handle = await fsp.open(scratch, "r+");
  const stats = await handle.stat();
  console.log("stat:", stats.isFile(), stats.size);
  console.log("stat undefined:", (await handle.stat(undefined)).isFile());
  await failure("stat null:", () => handle.stat(null));
  console.log("stat empty:", (await handle.stat({})).size);
  console.log("stat false:", (await handle.stat({ bigint: false })).size);
  const big = await handle.stat({ bigint: true });
  console.log("stat bigint:", big.size === BigInt(stats.size), typeof big.size);
  const storedFalse: { bigint?: false } = {};
  const plain = await handle.stat(storedFalse);
  console.log("stat stored:", plain.size, typeof plain.size);
  const storedTrue: { bigint: true } = { bigint: true };
  const storedBig = await handle.stat(storedTrue);
  console.log("stat stored bigint:", storedBig.size === BigInt(stats.size), typeof storedBig.size);
  function statWith(options: null | { bigint?: false }): Promise<fs.Stats> {
    return handle.stat(options);
  }
  await failure("stat parameter null:", () => statWith(null));
  console.log("stat parameter record:", (await statWith({})).size);
  await handle.close();
  // Node validates the handle before it reads the options value.
  await failure("closed stat:", () => handle.stat());
  await failure("closed stat null:", () => handle.stat(null));
}

async function closeLadder(): Promise<void> {
  const handle = await fsp.open(scratch, "r");
  const fd = handle.fd;
  console.log("fd open:", typeof fd === "number" && fd > 0);
  await handle.close();
  console.log("fd closed:", handle.fd);
  await handle.close();
  console.log("second close:", handle.fd);
  await failure("closed sync:", () => handle.sync());
  await failure("closed datasync:", () => handle.datasync());
  await failure("closed truncate:", () => handle.truncate(1));
  await failure("closed chmod:", () => handle.chmod(0o600));
  await failure("closed utimes:", () => handle.utimes(1, 1));
  await failure("closed readv:", () => handle.readv([Buffer.alloc(2)]));
  await failure("closed writev:", () => handle.writev([Buffer.from("x")]));
  await failure("closed read:", () => handle.read());
  await failure("closed write:", () => handle.write(Buffer.from("x")));
  const closedRead = await handle.read().catch((e: NodeJS.ErrnoException) => e.code);
  console.log("closed read code:", closedRead);
}

function pick(handle: fsp.FileHandle, present: boolean): fsp.FileHandle | undefined {
  return present ? handle : undefined;
}

async function disposal(): Promise<void> {
  const handle = await fsp.open(scratch, "r");
  await handle[Symbol.asyncDispose]();
  console.log("dispose closed:", handle.fd);
  await handle[Symbol.asyncDispose]();
  console.log("dispose again:", handle.fd);
  await failure("dispose then stat:", () => handle.stat());

  // A nullish receiver short-circuits without closing the handle.
  const guarded = await fsp.open(scratch, "r");
  await pick(guarded, false)?.[Symbol.asyncDispose]();
  console.log("guarded still open:", (await guarded.stat()).size);
  await pick(guarded, true)?.[Symbol.asyncDispose]();
  console.log("guarded closed:", guarded.fd);

  {
    await using scoped = await fsp.open(scratch, "r");
    console.log("using open:", scoped.fd > 0);
  }
  console.log("using closed");
}

async function main(): Promise<void> {
  fs.writeFileSync(scratch, "0123456789");
  await readWindows();
  await writeWindows();
  await readFileForms();
  await statOptions();
  await closeLadder();
  await disposal();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("cleaned:", !fs.existsSync(root));
}

void main();
