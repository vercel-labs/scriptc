// undici's fetch given the init a program already holds for the global
// fetch (a `RequestInit` value, here the one Node's types declare): passed
// as it is, spread into a new literal with a member replaced, and with the
// body kinds undici's fetch sends as bytes. A small station log server
// echoes what arrived.
import { createServer } from "node:http";
import { Agent, fetch as stationFetch, request } from "undici";

const server = createServer((req, res) => {
  const parts: Buffer[] = [];
  req.on("data", (chunk: Buffer) => parts.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(parts);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(
      [
        req.method,
        `station=${String(req.headers["x-station"] ?? "-")}`,
        `tide=${String(req.headers["x-tide"] ?? "-")}`,
        `type=${String(req.headers["content-type"] ?? "-")}`,
        `bytes=${body.length}`,
        JSON.stringify(body.toString("latin1")),
      ].join(" "),
    );
  });
});

// Sends a reading with the caller's init, adding the station's name to
// whatever headers the init has.
function send(url: string, station: string, base: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(base.headers);
  headers.set("x-station", station);
  return stationFetch(url, { ...base, headers });
}

async function log(label: string, pending: Promise<unknown>): Promise<void> {
  const answered = (await pending) as Response;
  console.log(`${label}: ${answered.status} ${await answered.text()}`);
}

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/log`;

  // An init held in a variable, and inits written at the call.
  const morning: RequestInit = { method: "POST", headers: { "x-tide": "high" }, body: "0612 4.2m" };
  await log("variable", send(url, "north", morning));
  await log("pairs", send(url, "north", { method: "PUT", headers: [["x-tide", "low"]], body: "1240 0.9m" }));
  await log("headers object", send(url, "south", { method: "POST", headers: new Headers({ "x-tide": "slack" }), body: "-" }));
  await log("nothing", send(url, "south"));
  await log("signal and redirect", send(url, "east", { signal: new AbortController().signal, redirect: "follow" }));

  // Bodies that are bytes: a typed array, an ArrayBuffer, a view of part of one.
  const samples = new Uint8Array([104, 105, 33, 10, 255]);
  await log("typed array", send(url, "west", { method: "POST", body: samples }));
  await log("array buffer", stationFetch(url, { method: "POST", body: samples.buffer.slice(0, 3) }));
  await log("data view", stationFetch(url, { method: "POST", body: new DataView(samples.buffer, 3, 2) }));

  // The same through a dispatcher of the package.
  const lines = new Agent();
  const evening: RequestInit = { method: "POST", headers: { "x-tide": "ebb", "x-station": "pier" }, body: "1903 1.4m" };
  await log("dispatcher", stationFetch(url, { ...evening, dispatcher: lines }));
  await log(
    "dispatcher bytes",
    stationFetch(url, { method: "POST", body: samples.buffer, dispatcher: lines, headers: { "x-station": "pier" } }),
  );

  // A method outside the nine names undici's declarations list: fetch()
  // and request() pass any token on to dispatch().
  await log("other method", stationFetch(url, { method: "PROPFIND", dispatcher: lines, headers: { "x-station": "pier" } }));
  const token: string = ["RE", "PORT"].join("");
  const reported = await request(url, { method: token as "GET", dispatcher: lines, headers: { "x-station": "pier" } });
  console.log(`request: ${reported.statusCode} ${await reported.body.text()}`);
  await lines.close();

  // A signal that is already aborted rejects.
  const stopped = new AbortController();
  stopped.abort();
  try {
    await send(url, "north", { signal: stopped.signal });
    console.log("sent anyway");
  } catch (err) {
    console.log(`aborted: ${(err as Error).name}`);
  }
  server.close();
});
