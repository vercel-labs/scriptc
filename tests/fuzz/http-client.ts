// The HTTP client under test: http.get and fetch against a server that answers damaged responses
// (scripts/fuzz-http.mjs). Every request must settle, as a response, an error or a timeout.
//
// Request i goes to /g<i> through http.get when i is even and to /f<i> through fetch when it is odd; the server
// chooses the response from i alone, so one request is replayed with <first> = i and <count> = 1.
import { get } from "node:http";

function viaGet(port: number, i: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const req = get({ host: "127.0.0.1", port, path: "/g" + i, headers: { connection: "close" } }, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve());
      res.on("error", () => resolve());
      res.on("close", () => resolve());
    });
    req.on("error", () => resolve());
    // A response that switches protocols with no 'upgrade' listener ends in 'close' alone.
    req.on("close", () => resolve());
    req.setTimeout(500, () => {
      req.destroy();
    });
  });
}

async function viaFetch(port: number, i: number): Promise<void> {
  try {
    const r = await fetch("http://127.0.0.1:" + port + "/f" + i, {
      redirect: i % 3 === 0 ? "follow" : "manual",
      signal: AbortSignal.timeout(500),
    });
    await r.text();
    r.headers.forEach(() => {});
  } catch (e) {}
}

export async function requests(port: number, first: number, count: number): Promise<void> {
  let settled = 0;
  for (let i = first; i < first + count; i++) {
    if (i % 2 === 0) await viaGet(port, i);
    else await viaFetch(port, i);
    settled++;
  }
  console.log("settled", settled);
}
