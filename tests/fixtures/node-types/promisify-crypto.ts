import * as crypto from "node:crypto";
import { promisify } from "node:util";

const randomBytes = promisify(crypto.randomBytes);
const pbkdf2 = promisify(crypto.pbkdf2);
const scrypt = promisify(crypto.scrypt);
const hkdf = promisify(crypto.hkdf);
const randomInt = promisify(crypto.randomInt);
const generateKey = promisify(crypto.generateKey);

console.log((await randomBytes(12)).length);
console.log((await pbkdf2("pw", "salt", 10, 16, "sha512")).toString("hex"));
console.log(((await scrypt("pw", "salt", 16)) as Buffer).toString("base64"));
console.log(Buffer.from(await hkdf("sha256", "key", "salt", "info", 12)).toString("hex"));
const n = (await randomInt(4)) as number;
console.log(n >= 0 && n < 4);
console.log((await generateKey("aes", { length: 128 })).symmetricKeySize);
try {
  await pbkdf2("pw", "salt", 1, 8, "md-none");
} catch (e) {
  if (e instanceof Error) console.log(e.name, e.message);
}
