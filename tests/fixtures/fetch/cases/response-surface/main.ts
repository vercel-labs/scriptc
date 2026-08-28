// @dynamic
// The Response surface beyond the probe members: r.headers is the engine's
// real Headers (get/has/getSetCookie/forEach — lowercase names,
// combine-on-append, sorted iteration), arrayBuffer() resolves to an
// engine ArrayBuffer of the body bytes (its byteLength reads directly),
// bytes() exits into a static Uint8Array copy at the typed boundary, and
// url/redirected/bodyUsed answer the fetch-spec values. Island results
// exit through TYPED bindings (the user-fetch pattern). Byte-exact vs Node.

async function main(baseUrl: string): Promise<void> {
  // Headers off a live response: get (present, missing → null), has,
  // getSetCookie on a cookie-less response, and the sorted forEach walk
  // (filtered to the fixture's own x- names — wire noise stays out).
  const r = await fetch(`${baseUrl}/text`);
  const responseType: string = (r as any).type;
  console.log("type:", responseType);
  const ct = r.headers["get"]("content-type");
  const kind = r.headers.get("x-kind");
  const missing = r.headers.get("x-nope");
  console.log("ct:", ct ?? "none");
  console.log("kind:", kind ?? "none", "missing:", missing ?? "none");
  console.log("has:", r.headers.has("x-kind"), r.headers.has("x-nope"));
  console.log("setCookie:", r.headers.getSetCookie().length);
  r.headers.forEach((v, k) => {
    if (k.startsWith("x-")) console.log("hdr:", k, "=", v);
  });
  try {
    const computedHeaderMember = (): "get" | "has" => "missing" as "get";
    const member = computedHeaderMember();
    r.headers[member]("x-kind");
    console.log("computed member unexpectedly accepted");
  } catch (error) {
    console.log("computed member:", (error as Error).name);
  }
  const explicitIterator = r.headers[Symbol.iterator]();
  const explicitFirst = explicitIterator.next();
  console.log(
    "iterator:",
    explicitFirst.done ? "done" : explicitFirst.value[0],
    explicitFirst.done ? "done" : explicitFirst.value[1],
  );
  let iteratedHeaders = 0;
  for (const [k] of r.headers) {
    if (k.startsWith("x-")) iteratedHeaders++;
  }
  console.log("for-of:", iteratedHeaders);
  const spreadHeaders = [...r.headers];
  console.log("spread:", spreadHeaders.length);
  const [destructuredFirst] = r.headers;
  console.log("destructure:", destructuredFirst[0], destructuredFirst[1]);
  const text: string = await r["text"]();
  console.log("used:", r.bodyUsed, "url-tail:", r.url.endsWith("/text"), "redirected:", r.redirected);
  console.log("text:", text);

  // Duplicate response headers combine on read (x-multi: a, b).
  const echoInit: RequestInit = {
    headers: { "x-echo-one": "1", "x-echo-two": "2" },
  };
  const he = await fetch(`${baseUrl}/header-echo`, { ...echoInit });
  const multi = he.headers.get("x-multi");
  const latin = he.headers.get("x-latin") ?? "";
  const echoed: string = await he.text();
  console.log("multi:", multi ?? "none");
  console.log("latin:", latin, latin.charCodeAt(0));
  console.log("echo:", echoed);

  // arrayBuffer(): the whole body as an engine ArrayBuffer handle.
  const jr = await fetch(`${baseUrl}/json`);
  const ab = await jr.arrayBuffer();
  console.log("ab:", ab.byteLength);

  // bytes(): a Uint8Array that exits to the static bytes tier (a copy).
  const tr = await fetch(`${baseUrl}/text`);
  const b: Uint8Array = await tr.bytes();
  console.log("bytes:", b.length, b[0], b[b.length - 1]);

  // Through a redirect, url names the FINAL target and redirected flips.
  const rd = await fetch(`${baseUrl}/redirect`);
  const rdBody: string = await rd.text();
  console.log("rd:", rd.redirected, rd.url.endsWith("/text"), rdBody);
}

main(process.argv[2]);
