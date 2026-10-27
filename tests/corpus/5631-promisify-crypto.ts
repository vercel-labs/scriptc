// util.promisify over the crypto callback functions: the promise settles
// with the value the callback form receives, or rejects with its error,
// after the call returns. An argument error rejects the promise instead of
// throwing. Random values are checked by length and range only.
import * as crypto from "node:crypto";
import { pbkdf2, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";

const randomBytesAsync = promisify(randomBytes);
const pbkdf2Async = promisify(pbkdf2);
const scryptAsync = promisify(scrypt);
const hkdfAsync = promisify(crypto.hkdf);
const randomFillAsync = promisify(crypto.randomFill);
const randomIntAsync = promisify(crypto.randomInt);
const generateKeyAsync = promisify(crypto.generateKey);

async function rejects(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.log(label, "fulfilled");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, "rejected", err.name, err.code, err.message);
  }
}

async function main(): Promise<void> {
  let returned = false;
  const pending = randomBytesAsync(16);
  returned = true;
  const bytes = await pending;
  console.log(
    "randomBytes",
    returned,
    bytes.length,
    bytes.toString("hex").length,
  );
  console.log("randomBytes 0", (await randomBytesAsync(0)).length);

  const derived = await pbkdf2Async("password", "salt", 1000, 32, "sha256");
  console.log("pbkdf2", derived.toString("hex"));
  console.log(
    "pbkdf2 bytes",
    (
      await pbkdf2Async(Buffer.from("pw"), new Uint8Array([1, 2]), 1, 8, "sha1")
    ).toString("hex"),
  );

  console.log(
    "scrypt",
    (await scryptAsync("password", "salt", 16)).toString("hex"),
  );
  console.log(
    "scrypt options",
    (await scryptAsync("password", "salt", 16, { N: 1024 })).toString("hex"),
  );

  const key = await hkdfAsync("sha256", "key", "salt", "info", 16);
  console.log(
    "hkdf",
    key instanceof ArrayBuffer,
    Buffer.from(key).toString("hex"),
  );

  const buf = Buffer.alloc(8);
  const filled = await randomFillAsync(buf);
  console.log("randomFill", filled === buf, filled.length);
  const view = new Uint32Array(4);
  const tail = await randomFillAsync(view, 2);
  console.log("randomFill offset", tail === view, view[0], view[1]);
  const middle = new Uint8Array(6);
  await randomFillAsync(middle, 1, 2);
  console.log("randomFill size", middle[0], middle[3], middle[4], middle[5]);

  const n = await randomIntAsync(10);
  console.log("randomInt", Number.isInteger(n), n >= 0 && n < 10);
  const m = await randomIntAsync(5, 7);
  console.log("randomInt range", m === 5 || m === 6);

  const secret = await generateKeyAsync("hmac", { length: 64 });
  console.log("generateKey", secret.type, secret.symmetricKeySize);

  await rejects("randomBytes size", async () => {
    await randomBytesAsync(-1);
  });
  await rejects("pbkdf2 digest", async () => {
    await pbkdf2Async("pw", "salt", 1, 8, "no-such-digest");
  });
  await rejects("pbkdf2 iterations", async () => {
    await pbkdf2Async("pw", "salt", 0, 8, "sha256");
  });
  await rejects("scrypt keylen", async () => {
    await scryptAsync("pw", "salt", -1);
  });
  await rejects("hkdf digest", async () => {
    await hkdfAsync("nope", "k", "s", "i", 8);
  });
  await rejects("randomFill offset", async () => {
    await randomFillAsync(Buffer.alloc(4), 9);
  });
  await rejects("randomInt range", async () => {
    await randomIntAsync(3, 3);
  });
  await rejects("generateKey length", async () => {
    await generateKeyAsync("hmac", { length: 3 });
  });

  const order: string[] = [];
  const first = randomBytesAsync(4).then(() => order.push("randomBytes"));
  const second = pbkdf2Async("a", "b", 1, 4, "sha256").then(() =>
    order.push("pbkdf2"),
  );
  order.push("sync");
  await Promise.all([first, second]);
  console.log("order", order[0]);
}

main().catch((e) => console.log("unexpected", String(e)));
