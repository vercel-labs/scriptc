// Headers in a static build: the accessor surface koa's response path reads
// (content-length, content-encoding, content-type), plus the rest of the
// statically lowered methods. Iteration (keys/values/entries and spreading)
// is fenced and covered by the untyped-iterator corpus instead.
function show(label: string, h: Headers): void {
  console.log(
    `${label} length=${JSON.stringify(h.get("content-length"))} ` +
      `encoding=${JSON.stringify(h.get("content-encoding"))} ` +
      `type=${JSON.stringify(h.get("content-type"))}`,
  );
}

const record = new Headers({
  "Content-Length": "0",
  "Content-Encoding": " identity ",
  "Content-Type": "text/plain; charset=utf-8",
});
show("record", record);
console.log(
  `case ${record.get("CONTENT-LENGTH")} ${record.has("Content-Encoding")} ${record.has("content-length")}`,
);
console.log(`missing ${JSON.stringify(record.get("content-type-x"))} ${record.has("content-type-x")}`);

const pairs = new Headers([
  ["content-encoding", "gzip"],
  ["Content-Encoding", "br"],
]);
console.log(`combined ${JSON.stringify(pairs.get("content-encoding"))}`);
pairs.set("content-encoding", "deflate");
console.log(`replaced ${JSON.stringify(pairs.get("content-encoding"))}`);
pairs.append("content-encoding", "gzip");
console.log(`appended ${JSON.stringify(pairs.get("content-encoding"))}`);
pairs.delete("content-encoding");
console.log(`deleted ${JSON.stringify(pairs.get("content-encoding"))} ${pairs.has("content-encoding")}`);

record.set("content-length", 42 as unknown as string);
record.set("x-null", null as unknown as string);
record.set("x-undefined", undefined as unknown as string);
record.set("x-boolean", true as unknown as string);
console.log(
  `coerced ${JSON.stringify(record.get("content-length"))} ` +
    `${JSON.stringify(record.get("x-null"))} ${JSON.stringify(record.get("x-undefined"))} ` +
    `${JSON.stringify(record.get("x-boolean"))}`,
);

function attempt(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`${label} no throw`);
  } catch (error) {
    console.log(`${label} ${(error as Error).name}: ${(error as Error).message}`);
  }
}
attempt("invalid name", () => record.set("x y", "1"));
attempt("invalid value", () => record.append("x-value", "a\nb"));

const cookies = new Headers();
cookies.append("Set-Cookie", "a=1");
cookies.append("set-cookie", "b=2");
cookies.append("Content-Type", "application/json");
console.log(`cookies ${JSON.stringify(cookies.getSetCookie())}`);
console.log(`cookie combined ${JSON.stringify(cookies.get("set-cookie"))}`);

const visit: string[] = [];
cookies.forEach((value, name) => visit.push(`${name}=${value}`));
console.log(`forEach ${visit.join(" | ")}`);

const copy = new Headers(record);
record.set("content-length", "1");
console.log(`copy ${JSON.stringify(copy.get("content-length"))} ${JSON.stringify(record.get("content-length"))}`);

const response = new Response("body", {
  status: 201,
  headers: { "content-type": "text/plain", "content-length": "4" },
});
console.log(
  `response ${response.status} ${JSON.stringify(response.headers.get("content-type"))} ` +
    `${JSON.stringify(response.headers.get("content-length"))}`,
);
const request = new Request("http://example.test/", {
  headers: [["content-encoding", "identity"]],
});
console.log(`request ${JSON.stringify(request.headers.get("content-encoding"))}`);
