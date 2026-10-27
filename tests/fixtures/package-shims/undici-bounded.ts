// Reads every response of undici-hostile-peer.mjs (port in argv[2]): the
// endless chunk-size lines through request(), the large and the gzipped
// bodies through fetch() with a pause after the first chunk. Memory stays
// bounded by the parser's and the body stream's buffers.
import { Agent, fetch, request } from "undici";

const MiB = 1024 * 1024;
const origin = `http://127.0.0.1:${process.argv[2]}`;
const dispatcher = new Agent();
for (const path of ["/extension", "/zeros"]) {
  const res = await request(`${origin}${path}`, { dispatcher });
  console.log(path, res.statusCode, await res.body.text());
}
for (const path of ["/big", "/bomb"]) {
  const res = await fetch(`${origin}${path}`, { dispatcher });
  const reader = res.body!.getReader();
  const first = await reader.read();
  let total = first.value!.length;
  await new Promise<void>((resolve) => setTimeout(resolve, 500));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value!.length;
  }
  console.log(path, res.status, total / MiB, "MiB");
}
const rss = process.memoryUsage().rss;
console.log(rss < 48 * MiB ? "rss under 48 MiB" : `rss ${Math.round(rss / MiB)} MiB`);
await dispatcher.close();
