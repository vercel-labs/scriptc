// Header values take Node's normalization: HTTP whitespace (SP, HT, LF, CR)
// comes off both ends before the check, and only NUL, CR and LF inside what
// is left are refused — so a value read from a file keeps its text without
// its newline, and other control bytes are legal header bytes. statusText
// keeps its own stricter rule, and the automatic Content-Type a file-backed
// Blob contributes is normalized the same way.
import { openAsBlob, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const show = async (label, fn) => {
  try {
    console.log(label, "ok", JSON.stringify(await fn()));
  } catch (caught) {
    console.log(label, "throw", caught.constructor.name, JSON.stringify(caught.message));
  }
};

await show("trailing newline", () => {
  const headers = new Headers();
  headers.append("x", "line\n");
  return headers.get("x");
});
await show("leading newline", () => {
  const headers = new Headers();
  headers.append("x", "\nline");
  return headers.get("x");
});
await show("trailing crlf", () => {
  const headers = new Headers();
  headers.append("x", "line\r\n");
  return headers.get("x");
});
await show("set trailing newline", () => {
  const headers = new Headers();
  headers.set("x", "v\n");
  return [...headers];
});
await show("record trailing newline", () => [...new Headers({ x: "value\n" })]);
await show("pair trailing newline", () => [...new Headers([["x", "v\r\n"]])]);
await show("only newlines", () => {
  const headers = new Headers();
  headers.append("x", " \r\n\t ");
  return headers.get("x");
});
await show("interior newline", () => {
  const headers = new Headers();
  headers.append("x", "  a\nb  ");
  return headers.get("x");
});
await show("interior cr", () => [...new Headers([["x", "a\rb"]])]);
await show("interior nul", () => [...new Headers([["x", "a\u0000b"]])]);
await show("del byte", () => {
  const headers = new Headers();
  headers.append("x", "a\u007fb");
  return headers.get("x");
});
await show("other control bytes", () => {
  const headers = new Headers();
  headers.append("x", "a\u0001b\u000bc\r");
  return headers.get("x");
});
await show("byte over 255", () => [...new Headers([["x", "Ā"]])]);
await show("response append newline", () => {
  const response = new Response(null);
  response.headers.append("x", "v\n");
  return response.headers.get("x");
});
await show("response init newline", () => new Response(null, { headers: [["x", "v\n"]] }).headers.get("x"));

await show("statusText spaces", () => new Response(null, { statusText: "  ok  " }).statusText);
await show("statusText tab", () => new Response(null, { statusText: "\tok\t" }).statusText);
await show("statusText newline", () => new Response(null, { statusText: "a\nb" }).statusText);
await show("statusText control", () => new Response(null, { statusText: "a\u0001b" }).statusText);
await show("statusText del", () => new Response(null, { statusText: "a\u007fb" }).statusText);

const path = join(tmpdir(), `scriptc-headers-${process.pid}.txt`);
writeFileSync(path, "hello");
const fileBlob = await openAsBlob(path, { type: "text/plain\n" });
console.log("file blob type", JSON.stringify(fileBlob.type));
await show("file blob header", () =>
  new Request("https://example.com/", { method: "POST", body: fileBlob }).headers.get(
    "content-type",
  ),
);
await show("file blob padded header", async () => {
  const padded = await openAsBlob(path, { type: "  text/plain  " });
  return new Request("https://example.com/", { method: "POST", body: padded }).headers.get(
    "content-type",
  );
});
await show("file blob explicit header", async () => {
  const typed = await openAsBlob(path, { type: "text/plain\n" });
  return new Request("https://example.com/", {
    method: "POST",
    body: typed,
    headers: { "content-type": "custom/x" },
  }).headers.get("content-type");
});
await show("response file blob header", async () =>
  new Response(await openAsBlob(path, { type: "text/plain\n" })).headers.get("content-type"),
);
console.log("blob type normalized", JSON.stringify(new Blob(["x"], { type: "text/plain\n" }).type));
