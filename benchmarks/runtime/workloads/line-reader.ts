// Line-by-line processing of a log file with readline over a file stream:
// 'line' events for about 67 MB of access-log lines, with light work per
// line (a status count, a path tally, byte totals).
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const path = process.argv[2]!;
const statuses = new Map<string, number>();
const paths = new Map<string, number>();
let lines = 0;
let chars = 0;
let bytes = 0;
let longest = 0;

const input = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
input.on("line", (line: string) => {
  lines++;
  chars += line.length;
  if (line.length > longest) longest = line.length;
  const quote = line.indexOf('"');
  const space = line.indexOf(" ", quote);
  const path = line.slice(space + 1, line.indexOf("/", line.indexOf("/", space) + 1));
  paths.set(path, (paths.get(path) ?? 0) + 1);
  const close = line.indexOf('"', space);
  const status = line.slice(close + 2, close + 5);
  statuses.set(status, (statuses.get(status) ?? 0) + 1);
  bytes += Number(line.slice(close + 6, line.indexOf(" ", close + 6)));
});
input.on("close", () => {
  console.log(`${lines} lines, ${chars} characters, longest ${longest}`);
  console.log(`bytes ${bytes}`);
  for (const status of [...statuses.keys()].sort()) console.log(`status ${status}: ${statuses.get(status)}`);
  for (const prefix of [...paths.keys()].sort()) console.log(`path ${prefix}: ${paths.get(prefix)}`);
});
