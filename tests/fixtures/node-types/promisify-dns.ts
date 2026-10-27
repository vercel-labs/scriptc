import * as dns from "node:dns";
import { promisify } from "node:util";

const lookup = promisify(dns.lookup);
const lookupService = promisify(dns.lookupService);

const one = await lookup("127.0.0.1");
console.log(one.address, one.family);
const all = await lookup("::1", { all: true });
console.log(all.map((entry) => `${entry.address}/${entry.family}`).join(","));
const service = await lookupService("127.0.0.1", 80);
console.log(typeof service.hostname, typeof service.service);
try {
  await lookup("no-such-host.invalid");
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log(err.code, err.message);
}
