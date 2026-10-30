// Response.clone() and Request.clone() in a static build: fetched
// responses (a whole body, and one that arrives in chunks across a
// multibyte character), constructed responses and requests, the clone's
// metadata and header copy, a clone of a clone, and Node's TypeErrors for a
// used or locked body.
const base = process.argv[2]!;
const describe = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

const fetched = await fetch(`${base}/text`);
const fetchedCopy = fetched.clone();
console.log(fetchedCopy.status, fetchedCopy.headers.get("x-kind"), fetchedCopy.url === fetched.url, fetchedCopy.redirected);
console.log(await fetchedCopy.text(), await fetched.text(), fetched.bodyUsed, fetchedCopy.bodyUsed);
try {
  fetched.clone();
} catch (e) {
  console.log("used", describe(e));
}

const chunked = await fetch(`${base}/chunked`);
const chunkedCopy = chunked.clone().clone();
console.log(await chunked.text(), await chunkedCopy.text());

const made = new Response("made", { status: 203, statusText: "Copied", headers: { "x-a": "1" } });
const madeCopy = made.clone();
madeCopy.headers.set("x-a", "2");
console.log(madeCopy.status, madeCopy.statusText, made.headers.get("x-a"), madeCopy.headers.get("x-a"));
console.log(await made.text(), await madeCopy.text());

const locked = new Response("locked");
locked.body!.getReader();
try {
  locked.clone();
} catch (e) {
  console.log("locked", describe(e));
}

const request = new Request(`${base}/post-echo`, { method: "POST", body: "request body", headers: { "x-b": "3" } });
const requestCopy = request.clone();
console.log(requestCopy.method, requestCopy.headers.get("x-b"), await requestCopy.text(), await request.text());
try {
  request.clone();
} catch (e) {
  console.log("request used", describe(e));
}
