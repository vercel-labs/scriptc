// fetch() encodes a FormData body as undici's multipart/form-data: a
// random boundary in the content-type, one part per entry in list order
// (name and filename escaped, string values with their linefeeds
// normalized, Blob/File values as application/octet-stream parts), and the
// closing "--boundary--". The boundary is random, so it is normalized.
import { createServer } from "node:http";

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    // The first part line is "--<boundary>"; the boundary carries no CRLF.
    const firstBreak = body.indexOf("\r\n");
    let boundary = body.slice(2, firstBreak);
    if (boundary.endsWith("--")) boundary = boundary.slice(0, -2);
    const type = String(req.headers["content-type"]);
    console.log(type.split(boundary).join("<boundary>"));
    console.log("length", req.headers["content-length"], "encoding", req.headers["transfer-encoding"]);
    console.log(JSON.stringify(body.split(boundary).join("<boundary>")));
    res.end("ok");
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const url = `http://127.0.0.1:${port}/`;

const form = new FormData();
form.append("name", "value");
form.append("linefeeds", "a\nb\rc\r\nd");
form.append("quote", 'say "hi"');
form.append("empty", "");
form.append("file", new File(["file-bytes"], "file.txt", { type: "text/plain" }));
form.append("blob", new Blob(["blob-bytes"], { type: "application/x-blob" }));
form.append("named", new Blob(["q"]), "custom.bin");
form.append("untyped", new File([new Uint8Array([0, 1, 2, 255])], "raw.bin"));

console.log(await (await fetch(url, { method: "POST", body: form })).text());

// A content-type the caller sets is kept; the body is still multipart.
console.log(
  await (
    await fetch(url, { method: "POST", body: form, headers: { "content-type": "text/plain" } })
  ).text(),
);

// The same body through a native Request value.
const request = new Request(url, { method: "POST", body: form });
console.log(await (await fetch(request)).text());

// A Response body takes the same encoding.
const response = new Response(form);
const responseType = String(response.headers.get("content-type"));
console.log(responseType.replace(responseType.slice(responseType.indexOf("boundary=") + 9), "<boundary>"));

// An empty entry list is one closing boundary.
const empty = new FormData();
console.log(await (await fetch(url, { method: "POST", body: empty })).text());

server.close();
