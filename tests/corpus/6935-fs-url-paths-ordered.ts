// URL paths that Node converts inside a try or after checking other
// arguments: existsSync answers false for a URL it cannot convert, the
// fs.promises functions return a promise rejected with the conversion's
// error, copyFileSync and renameSync check a string source before they
// convert a URL destination, and readFileSync checks a runtime encoding
// before it converts the URL.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fs-url-ordered-")));
const at = (name: string): URL => pathToFileURL(path.join(dir, name));
const scheme = new URL("http://example.com/a.txt");
const host = new URL("file://example.com/a.txt");

function report(label: string, error: unknown): void {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.log(label, error.name, code, error.message.split(dir).join("<dir>"));
  }
}

function attempt(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "returned");
  } catch (error) {
    report(label, error);
  }
}

async function settle(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    console.log(label, "fulfilled");
  } catch (error) {
    report(label, error);
  }
}

async function main(): Promise<void> {
  fs.writeFileSync(at("a b.txt"), "hello");
  console.log(fs.existsSync(at("a b.txt")), fs.existsSync(at("missing")));
  console.log(fs.existsSync(scheme), fs.existsSync(host), fs.existsSync(new URL("file:///tmp/a%2Fb")));
  console.log(fs.existsSync(new URL("file:///tmp/a%00b")));

  console.log(await fsp.readFile(at("a b.txt"), "utf8"));
  console.log((await fsp.readFile(at("a b.txt"))).length);
  await fsp.writeFile(at("w.txt"), "written");
  await fsp.appendFile(at("w.txt"), "!");
  console.log((await fsp.stat(at("w.txt"))).size, (await fsp.lstat(at("w.txt"))).isFile());
  await fsp.access(at("w.txt"));
  await fsp.chmod(at("w.txt"), 0o644);
  await fsp.truncate(at("w.txt"), 3);
  await fsp.copyFile(at("w.txt"), at("copy.txt"));
  await fsp.rename(at("copy.txt"), at("moved.txt"));
  console.log(await fsp.readFile(at("moved.txt"), "utf8"));
  await fsp.mkdir(at("sub/deep"), { recursive: true });
  console.log(await fsp.readdir(at("sub")));
  console.log(path.dirname(await fsp.mkdtemp(at("tmp-"))) === dir);
  console.log((await fsp.realpath(at("sub/../sub"))).split(dir).join("<dir>"));
  // An array literal lowers its elements more than once.
  console.log([await fsp.realpath(at("sub"))].length, [fs.existsSync(scheme)][0]);
  // A later argument with effects runs once per call there, and the call
  // receives its value.
  let dataCalls = 0;
  const data = (): string => {
    dataCalls++;
    return `data ${dataCalls}`;
  };
  console.log([await fsp.writeFile(at("w.txt"), data())].length, dataCalls);
  console.log(await fsp.readFile(at("w.txt"), "utf8"));
  const code = (error: unknown): string => String((error as { code?: string }).code);
  const outcomes = [
    await fsp.writeFile(scheme, data()).then(() => "fulfilled", code),
    await fsp.appendFile(at("w.txt"), data()).then(() => "fulfilled", code),
  ];
  console.log(outcomes, dataCalls);
  console.log(await fsp.readFile(at("w.txt"), "utf8"));
  await fsp.rmdir(at("sub/deep"));
  await fsp.unlink(at("moved.txt"));
  await fsp.rm(at("w.txt"));
  await fsp.rm(at("sub"), { recursive: true, force: true });
  console.log(fs.existsSync(at("sub")));

  // The promise is returned; the error arrives as its rejection.
  const pending = fsp.stat(scheme);
  console.log("returned a promise");
  await pending.catch((error: unknown) => report("stat scheme", error));
  await settle("readFile host", () => fsp.readFile(host, "utf8"));
  await settle("copyFile both", () => fsp.copyFile(scheme, host));
  await settle("rename dest", () => fsp.rename(at("a b.txt"), host));
  await settle("writeFile separator", () => fsp.writeFile(new URL("file:///tmp/a%2fb"), "x"));
  await settle("unlink missing", () => fsp.unlink(at("missing")));
  await settle("rm scheme options", () => fsp.rm(scheme, { recursive: true, force: true }));

  // Arguments inside type-only wrappers are evaluated once.
  let modeCalls = 0;
  const countedMode = (): number => {
    modeCalls++;
    return 0o644;
  };
  await settle("chmod satisfies", () => fsp.chmod(scheme, countedMode() satisfies number));
  await settle("chmod as", () => fsp.chmod(at("a b.txt"), countedMode() as number));
  await settle("chmod non-null", () => fsp.chmod(host, countedMode()!));
  console.log("mode calls", modeCalls);
  await settle("copyFile as", () => fsp.copyFile(scheme, at("c.txt") as URL));
  await settle("copyFile dest as", () => fsp.copyFile(at("a b.txt"), host as URL));

  attempt("copyFileSync source first", () => fs.copyFileSync("a\0b", scheme));
  attempt("copyFileSync dest", () => fs.copyFileSync(path.join(dir, "a b.txt"), host));
  attempt("renameSync source first", () => fs.renameSync("a\0b", host));
  fs.copyFileSync(path.join(dir, "a b.txt"), at("copied.txt"));
  console.log(fs.readFileSync(at("copied.txt"), "utf8"));

  const encodings = ["utf8", "latin1", "base64", "bogus"];
  for (const encoding of encodings) {
    attempt(`readFileSync ${encoding}`, () => {
      console.log(fs.readFileSync(at("a b.txt"), encoding as BufferEncoding));
    });
    attempt(`readFileSync ${encoding} scheme`, () => {
      console.log(fs.readFileSync(scheme, encoding as BufferEncoding));
    });
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("done", fs.existsSync(dir));
}

void main();
