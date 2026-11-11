// @exit: 1
// fs.close(fd[, callback]): a valid descriptor closes silently, a descriptor
// that is not open reports EBADF through the callback asynchronously, the fd
// range checks throw at the call, an explicit null callback throws the
// makeCallback TypeError (only an omitted or undefined callback gets Node's
// default), and a failed close without a callback becomes the default
// callback throwing an uncaught exception on a later turn.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-close-"));
const file = path.join(dir, "file.txt");
fs.writeFileSync(file, "payload");

const unopened = 9999;

function closeWith(fd: number): Promise<string> {
  return new Promise((resolve) => {
    fs.close(fd, (error) => {
      resolve(error ? `${error.code}: ${error.message}` : "closed");
    });
  });
}

function thrown(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "accepted");
  } catch (error) {
    if (error instanceof Error) {
      console.log(label, error.name, (error as NodeJS.ErrnoException).code, error.message);
    } else {
      console.log(label, "non-error");
    }
  }
}

async function main(): Promise<void> {
  const fd = fs.openSync(file, "r");
  console.log("open", await closeWith(fd));
  console.log("unopened", await closeWith(unopened));

  thrown("negative", () => fs.close(-1, () => {}));
  thrown("fractional", () => fs.close(1.5, () => {}));
  thrown("too large", () => fs.close(2147483648, () => {}));

  const scratch = fs.openSync(file, "r");
  thrown("null callback", () => fs.close(scratch, null as never));
  fs.closeSync(scratch);

  console.log("before uncaught");
  fs.close(unopened);
}

main();
