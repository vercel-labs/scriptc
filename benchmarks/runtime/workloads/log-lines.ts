// A logging-heavy CLI: one console line per record, written immediately.
// Mixes the common console shapes (a single template literal, string plus
// number arguments, several primitive arguments) with process.stdout.write
// chunks and an occasional console.error line.
interface LogRecord {
  id: number;
  method: string;
  path: string;
  status: number;
  latency: number;
  cached: boolean;
}

const methods = ["GET", "POST", "PUT", "DELETE"];
const paths = ["/api/users", "/api/orders", "/health", "/static/app.js", "/api/search?q=caf\u00e9"];

let seed = 7;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}

function makeRecord(id: number): LogRecord {
  const r = random();
  return {
    id,
    method: methods[id % methods.length]!,
    path: paths[Math.floor(random() * paths.length)]!,
    status: r < 0.9 ? 200 : r < 0.97 ? 404 : 500,
    latency: Math.round(random() * 250000) / 1000,
    cached: random() < 0.3,
  };
}

const scale = Number(process.argv[2] ?? "1");
const count = Math.round(50000 * scale);
let errors = 0;
let bytes = 0;
for (let i = 0; i < count; i++) {
  const rec = makeRecord(i);
  switch (i % 4) {
    case 0:
      console.log(`${rec.method} ${rec.path} ${rec.status} ${rec.latency}ms`);
      break;
    case 1:
      console.log("request", rec.id, rec.method, rec.status);
      break;
    case 2:
      console.log("latency", rec.latency, "cached", rec.cached);
      break;
    default: {
      const chunk = "[" + rec.id + "] " + rec.path + (rec.cached ? " (cached)" : "") + "\n";
      bytes += chunk.length;
      process.stdout.write(chunk);
    }
  }
  if (rec.status === 500) {
    errors++;
    if (errors % 100 === 0) console.error("error budget: " + errors + " server errors at record " + rec.id);
  }
}
console.log("records", count, "errors", errors, "chunk chars", bytes);
