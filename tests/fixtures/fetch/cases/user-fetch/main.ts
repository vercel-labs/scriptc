// @dynamic
// USER-code fetch — the island-backed ambient in the program's OWN
// TypeScript (no npm package in sight): `await fetch(url)` bridges the
// engine promise to a static one, the Response is an island handle whose
// members are engine ops (ok/status/statusText probe reads, json() through
// a checked cast, text() into a string slot), init literals build natively
// in the island (method/headers/body/signal), AbortSignal.timeout cancels,
// and network failure rejects catchably. Byte-exact vs Node.

async function requestStream(baseUrl: string): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(`${baseUrl}/chunked`);
  if (response.body === null) throw new Error("missing response body");
  return response.body;
}

async function main(baseUrl: string, refusedUrl: string): Promise<void> {
  const constructed = new Response("island response", {
    status: 202,
    statusText: "Accepted",
    headers: { "x-constructed": "yes" },
  });
  constructed.headers.append("x-constructed", "again");
  const constructedHeader: string | null =
    constructed.headers.get("x-constructed");
  const constructedBody: string = await constructed.text();
  console.log(
    "constructed:",
    constructed.status,
    constructed.statusText,
    constructedHeader ?? "none",
    constructedBody,
  );

  // ok + status through the handle; json() exits through a checked cast.
  const r = await fetch(`${baseUrl}/json`);
  console.log("ok:", r.ok ? "yes" : "no", "status:", `${r.status}`);
  const j = (await r.json()) as { n: number; s: string; arr: (number | string)[] };
  console.log("json:", j.n, j.s, j.arr.length);

  // text() lands in a string slot through the validated exit.
  const t = await fetch(`${baseUrl}/text`);
  const body: string = await t.text();
  console.log("text:", body);

  const concatenatedGzip: string = await (
    await fetch(`${baseUrl}/gzip-concat`)
  ).text();
  console.log("concatenated gzip:", concatenatedGzip);

  // HTTP errors RESOLVE: 404 probes read ok/status/statusText.
  const nf = await fetch(baseUrl + "/nope");
  if (!nf.ok) {
    console.log("nf:", `${nf.status}`, `${nf.statusText}`);
    const nfBody: string = await nf.text();
    console.log("nf-body:", nfBody);
  }

  // POST with an init literal: method, headers, body cross the boundary.
  const echoed = await fetch(`${baseUrl}/post-echo`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-tag": "native" },
    body: JSON.stringify({ q: 7 }),
  });
  const ej = (await echoed.json()) as {
    method: string;
    contentType: string | null;
    body: string;
  };
  console.log("post:", ej.method, ej.contentType ?? "none", ej.body);

  // A request ReadableStream crosses the island incrementally instead of
  // being silently discarded.
  const streamed = await fetch(`${baseUrl}/post-echo`, {
    method: "POST",
    body: await requestStream(baseUrl),
    duplex: "half",
  });
  const streamedJson = (await streamed.json()) as {
    method: string;
    body: string;
  };
  console.log("stream post:", streamedJson.method, streamedJson.body);

  const matchedStreamLength = await fetch(`${baseUrl}/post-echo`, {
    method: "POST",
    headers: { "content-length": "14" },
    body: await requestStream(baseUrl),
    duplex: "half",
  });
  const matchedStreamLengthJson = (await matchedStreamLength.json()) as {
    contentLength: string | null;
    body: string;
  };
  console.log(
    "matched stream content-length:",
    matchedStreamLengthJson.contentLength,
    matchedStreamLengthJson.body,
  );

  try {
    await fetch(`${baseUrl}/post-echo`, {
      method: "POST",
      headers: { "content-length": "20" },
      body: await requestStream(baseUrl),
      duplex: "half",
      signal: AbortSignal.timeout(200),
    });
    console.log("stream content-length mismatch: resolved");
  } catch (e) {
    if (e instanceof Error) {
      console.log("stream content-length mismatch:", e.name, e.message);
    }
  }

  // All three redirect policies are implemented by the dynamic bridge.
  const manual = await fetch(`${baseUrl}/redirect`, { redirect: "manual" });
  console.log(
    "manual redirect:",
    `${manual.status}`,
    manual.redirected ? "redirected" : "direct",
    manual.url.endsWith("/redirect") ? "original" : "changed",
    JSON.stringify(await manual.text()),
  );
  try {
    await fetch(`${baseUrl}/redirect`, { redirect: "error" });
    console.log("error redirect: resolved");
  } catch (e) {
    if (e instanceof Error) console.log("error redirect:", e.name, e.message);
  }

  // A consumed stream is not replayable across 301/302/307/308. A 303 may
  // discard it while rewriting the request to GET.
  try {
    await fetch(`${baseUrl}/redirect-stream-302`, {
      method: "POST",
      body: await requestStream(baseUrl),
      duplex: "half",
    });
    console.log("stream redirect 302: resolved");
  } catch (e) {
    if (e instanceof Error) console.log("stream redirect 302:", e.name, e.message);
  }
  const stream303 = await fetch(`${baseUrl}/redirect-stream-303`, {
    method: "POST",
    headers: { "content-length": "14" },
    body: await requestStream(baseUrl),
    duplex: "half",
  });
  const stream303Json = (await stream303.json()) as {
    method: string;
    body: string;
  };
  console.log("stream redirect 303:", stream303Json.method, JSON.stringify(stream303Json.body));

  const modeResponse = await fetch(`${baseUrl}/request-defaults`, {
    headers: { "sec-fetch-mode": "navigate" },
  });
  const modeJson = (await modeResponse.json()) as { secFetchMode: string };
  console.log("forced sec-fetch-mode:", modeJson.secFetchMode);

  const hostResponse = await fetch(`${baseUrl}/request-defaults`, {
    headers: { host: "custom.invalid" },
  });
  const hostJson = (await hostResponse.json()) as { host: string };
  console.log(
    "transport-controlled host:",
    hostJson.host === new URL(baseUrl).host,
  );

  // A stored Response promise awaits later like any static promise.
  const pending: Promise<Response> = fetch(`${baseUrl}/json`);
  const again = await pending;
  console.log("again:", again.ok ? "ok" : "not-ok");

  // AbortSignal.timeout: the slow route loses the race to the timer.
  try {
    await fetch(`${baseUrl}/slow`, { signal: AbortSignal.timeout(50) });
    console.log("timeout: resolved");
  } catch (e) {
    if (e instanceof Error) console.log("timeout:", e.name, e.message);
  }

  // Typed user code can also cancel imperatively under --dynamic; this
  // exercises the compiler bridge into the island's AbortController.
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  try {
    await fetch(`${baseUrl}/slow`, { signal: controller.signal });
    console.log("controller: resolved");
  } catch (e) {
    if (e instanceof Error) console.log("controller:", e.name, e.message);
  }

  // A 101 is handed to the HTTP client's upgrade path rather than its
  // response path. fetch rejects it instead of leaving the promise pending.
  try {
    await fetch(`${baseUrl}/switching-protocols`);
    console.log("switching protocols: resolved");
  } catch (e) {
    if (e instanceof Error) {
      console.log("switching protocols:", e.name, e.message);
    }
  }

  // Connection refused: fetch REJECTS (TypeError, Node's message).
  try {
    await fetch(refusedUrl);
    console.log("refused: resolved");
  } catch (e) {
    if (e instanceof Error) console.log("refused:", e.name, e.message);
  }
}

main(process.argv[2], process.argv[3]);
