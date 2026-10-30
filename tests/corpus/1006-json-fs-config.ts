// THE real-world boundary pattern: read a JSON config file, parse it,
// validate it with a checked cast, use the typed value. readFileSync →
// JSON.parse → `as Config` → use. Valid cast (the file is well-formed);
// fields and keys alphabetical (see 1000-json-stringify-basics.ts).
import { readFileSync, rmSync, writeFileSync } from "node:fs";

function tail(path: string): string {
  let i = path.length - 1;
  while (i >= 0 && path.charAt(i) !== "/" && path.charAt(i) !== "\\") {
    i = i - 1;
  }
  return path.slice(i + 1);
}
const path = "tmp-1006-" + tail(process.argv[1]) + "-" + process.pid + ".json";

type Config = {
  name: string;
  retries: number;
  server: { host: string; port: number };
  verbose: boolean;
};

// Write a config carrying extra keys the type doesn't declare (width
// tolerance), then round-trip it through the boundary.
writeFileSync(
  path,
  '{"comment":"not in the type","name":"worker",' +
    '"retries":3,"server":{"host":"127.0.0.1","port":9090},"verbose":false}',
);

const cfg = JSON.parse(readFileSync(path, "utf8")) as Config;
console.log(cfg.name, cfg.retries, cfg.verbose);
console.log(cfg.server.host + ":" + cfg.server.port);

// Use the typed config to drive ordinary logic.
let attempts = 0;
for (let i = 0; i < cfg.retries; i = i + 1) {
  attempts = attempts + 1;
}
console.log("attempts:", attempts);

// Persist a derived config and read it back — stringify output is valid
// input for parse (and for Node's, byte-for-byte).
const derived = {
  name: cfg.name + "-v2",
  retries: cfg.retries * 2,
  server: { host: cfg.server.host, port: cfg.server.port + 1 },
  verbose: true,
};
writeFileSync(path, JSON.stringify(derived));
const back = JSON.parse(readFileSync(path, "utf8")) as Config;
console.log(back.name, back.retries, back.server.port, back.verbose);

// A corrupted config file fails CATCHABLY at the parse.
writeFileSync(path, '{"name":"broken",');
try {
  const bad = JSON.parse(readFileSync(path, "utf8")) as Config;
  console.log("unreachable", bad.name);
} catch {
  console.log("caught corrupt config");
}

rmSync(path);
