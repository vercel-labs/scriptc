// fs/promises writeFile and appendFile with data whose type is the
// string|Uint8Array union a shared helper carries: the arm decides how the
// data is written, and the options record means the same on either arm.
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "scr-promise-union-"));
const file = (name: string): string => path.join(dir, name);
const hex = (name: string): string => nodeFs.readFileSync(file(name)).toString("hex");
const text = (flag: boolean): string | Uint8Array =>
  flag ? "héllo" : new Uint8Array([0x68, 0xc3, 0xa9]);
const buffered = (flag: boolean): string | Buffer =>
  flag ? "buf" : Buffer.from([0, 1, 2]);
const report = (label: string, e: unknown): void => {
  if (e instanceof Error) {
    console.log(label, e.name, (e as NodeJS.ErrnoException).code, e.message);
  } else console.log(label, "non-error", String(e));
};
const plain = async (label: string, run: () => Promise<void>): Promise<void> => {
  try {
    await run();
    console.log(label, "ok");
  } catch (e) {
    report(label, e);
  }
};

async function main(): Promise<void> {
  await fs.writeFile(file("plain-string"), text(true));
  await fs.writeFile(file("plain-bytes"), text(false));
  await fs.appendFile(file("plain-string"), text(false));
  await fs.appendFile(file("plain-bytes"), text(true));
  await fs.writeFile(file("encoding-string"), text(true), "utf8");
  await fs.writeFile(file("encoding-bytes"), text(false), "utf8");
  await fs.appendFile(file("encoding-bytes"), text(false), "latin1");
  await fs.writeFile(file("record-string"), text(true), { encoding: "latin1", mode: 0o600 });
  await fs.writeFile(file("record-bytes"), text(false), { encoding: "latin1", flush: true });
  await fs.appendFile(file("record-bytes"), text(true), { encoding: "utf8" });
  await fs.writeFile(file("buffer-bytes"), buffered(false));
  await fs.writeFile(file("buffer-string"), buffered(true), { encoding: "utf8" });
  await fs.appendFile(file("buffer-string"), buffered(false));
  for (const name of [
    "plain-string",
    "plain-bytes",
    "encoding-string",
    "encoding-bytes",
    "record-string",
    "record-bytes",
    "buffer-bytes",
    "buffer-string",
  ]) {
    console.log(name, hex(name));
  }

  // A refused encoding rejects on either arm, and the write does not run.
  const bad = "nope" as BufferEncoding;
  await plain("refuse-string", () => fs.writeFile(file("bad"), text(true), bad));
  await plain("refuse-bytes", () => fs.writeFile(file("bad"), text(false), bad));
  await plain("refuse-record", () => fs.appendFile(file("bad"), text(true), { encoding: bad }));
}

main()
  .then(() => {
    nodeFs.rmSync(dir, { recursive: true, force: true });
    console.log("removed:", !nodeFs.existsSync(dir));
  })
  .catch((e: unknown) => {
    console.log("main failed", String(e));
    nodeFs.rmSync(dir, { recursive: true, force: true });
  });
