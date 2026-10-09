// Regex-driven log processing: match with capture groups, test, and replace.
let seed = 99;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}

const methods = ["GET", "POST", "PUT", "DELETE"];
const paths = ["/api/users", "/api/orders", "/static/app.js", "/health", "/api/items/search"];
function makeLines(count: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const ip = `10.${Math.floor(random() * 255)}.${Math.floor(random() * 255)}.${Math.floor(random() * 255)}`;
    const method = methods[Math.floor(random() * methods.length)]!;
    const path = paths[Math.floor(random() * paths.length)]! + (random() < 0.3 ? "?id=" + Math.floor(random() * 1000) : "");
    const status = random() < 0.9 ? 200 : random() < 0.5 ? 404 : 500;
    const ms = Math.floor(random() * 900);
    const agent = random() < 0.5 ? "Mozilla/5.0 (Macintosh)" : "curl/8.4.0";
    lines.push(`${ip} - - [07/Oct/2026:12:${String(i % 60).padStart(2, "0")}:00 +0000] "${method} ${path} HTTP/1.1" ${status} ${ms} "${agent}"`);
  }
  return lines;
}

const linePattern = /^(\d+\.\d+\.\d+\.\d+) - - \[([^\]]+)\] "(\w+) ([^ ?"]+)(?:\?([^ "]*))? HTTP\/1\.1" (\d{3}) (\d+) "([^"]*)"$/;
const botPattern = /curl|bot|spider/i;
const digits = /\d+/g;

const scale = Number(process.argv[2] ?? "1");
const lines = makeLines(Math.floor(30000 * scale));
const counts = new Map<string, number>();
let errors = 0;
let bots = 0;
let totalMs = 0;
let redactedLength = 0;
for (let round = 0; round < 3; round++) {
  for (const line of lines) {
    const m = linePattern.exec(line);
    if (m === null) continue;
    const key = m[3]! + " " + m[4]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (m[6] !== "200") errors++;
    if (botPattern.test(m[8]!)) bots++;
    totalMs += Number(m[7]);
    redactedLength += line.replace(digits, "#").length;
  }
}
const keys = [...counts.keys()].sort();
for (const key of keys) console.log(key, counts.get(key));
console.log("errors", errors, "bots", bots, "ms", totalMs, "redacted", redactedLength);
