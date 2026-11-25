// @requires-libnode
// A Node island's fetch with the program's AbortSignal: the request starts,
// and aborting natively while it is in flight rejects it with the signal's
// reason. A server of the program answers one path and never answers the
// other.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

interface FetchOptions {
  signal: AbortSignal;
}

const requests: string[] = [];
const server = createServer((request, response) => {
  requests.push(request.url ?? "");
  if (request.url === "/fast") {
    response.end("fast body");
    return;
  }
  // "/slow": never answered; the abort ends it.
});

async function main(port: number): Promise<void> {
  const base = `http://127.0.0.1:${port}`;

  // The signal never aborts: the request completes.
  const quiet = new AbortController();
  const quietOptions: FetchOptions = { signal: quiet.signal };
  console.log(await lib.get(`${base}/fast`, quietOptions));

  // Aborted while in flight, with the program's Error.
  const controller = new AbortController();
  const options: FetchOptions = { signal: controller.signal };
  const pending: Promise<string> = lib.get(`${base}/slow`, options);
  setTimeout(() => controller.abort(new Error("user cancelled")), 50);
  console.log(await pending);

  // Aborted with no reason: the default AbortError, as the program sees it
  // when the island's rejection reaches it.
  const second = new AbortController();
  const raw: Promise<string> = lib.raw(`${base}/slow`, second.signal);
  setTimeout(() => second.abort(), 50);
  try {
    console.log(await raw);
  } catch (error) {
    console.log("raw rejected", (error as Error).name, (error as Error).message);
  }

  // A native timeout signal ends the request.
  const timeoutOptions: FetchOptions = { signal: AbortSignal.timeout(50) };
  console.log(await lib.get(`${base}/slow`, timeoutOptions));

  // Already aborted: no request leaves.
  const before = requests.length;
  const dead: FetchOptions = { signal: AbortSignal.abort(new Error("too late")) };
  console.log(await lib.get(`${base}/fast`, dead), requests.length === before);

  console.log("requests", requests.join(" "));
  server.close();
  server.closeAllConnections();
}

server.listen(0, "127.0.0.1", () => {
  void main((server.address() as AddressInfo).port);
});
