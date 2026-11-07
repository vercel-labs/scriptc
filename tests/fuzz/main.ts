// The fuzz program: every target of tests/fuzz in one executable, so one sanitized build serves them all
// (tests/fuzz/README.md; scripts/fuzz.mjs builds and drives it). It also runs under Node.
//   main <target> replay <file>...
//   main <target> fuzz <seeds dir> <seed> <first> <count> [v|c|d]
//   main http-server <port> [log]
//   main http-client <port> <first> <count>
import * as bytes from "./bytes.ts";
import { drive } from "./fz.ts";
import { requests } from "./http-client.ts";
import { serve } from "./http-server.ts";
import * as json from "./json.ts";
import * as number from "./number.ts";
import * as path from "./path.ts";
import * as regex from "./regex.ts";
import * as url from "./url.ts";
import * as zlib from "./zlib.ts";

const target = process.argv[2] ?? "";
const rest = process.argv.slice(3);
if (target === "bytes") drive(rest, bytes.generate, bytes.execute);
else if (target === "json") drive(rest, json.generate, json.execute);
else if (target === "number") drive(rest, number.generate, number.execute);
else if (target === "path") drive(rest, path.generate, path.execute);
else if (target === "regex") drive(rest, regex.generate, regex.execute);
else if (target === "url") drive(rest, url.generate, url.execute);
else if (target === "zlib") drive(rest, zlib.generate, zlib.execute);
else if (target === "http-server") serve(Number(rest[0] ?? "0"), rest[1] === "log");
else if (target === "http-client") await requests(Number(rest[0] ?? "0"), Number(rest[1] ?? "0"), Number(rest[2] ?? "1"));
else {
  console.error("unknown target:", target);
  process.exit(2);
}
