// A server 'timeout' callback that captures its server (and job data) must
// not keep the closed server alive: settling the server releases the
// callbacks the context registered. The sanitized lane's reference-count
// audit reports any that outlive the close.
import * as http2 from "node:http2";

const ROUNDS = 24;
const lines: string[] = [];

function round(n: number): void {
  const server = http2.createServer();
  const payload = Buffer.alloc(1024 * 1024, 0x41);
  let hits = 0;
  let seen: http2.Http2Server | null = null;
  server.setTimeout(600000, () => {
    hits += payload.length;
    seen = server;
  });
  server.listen(0, () => {
    server.close(() => {
      lines.push(`closed ${n} ${hits} ${seen === null}`);
      if (n + 1 < ROUNDS) round(n + 1);
    });
  });
}

await new Promise<void>((resolve) => {
  round(0);
  const check = (): void => {
    if (lines.length === ROUNDS) resolve();
    else setTimeout(check, 20);
  };
  check();
});

for (const line of lines.sort()) console.log(line);
