// The multipart encoding's escaping: a field name's line feeds are
// normalized to CRLF and then percent-encoded with its quotes, a filename
// only has its quotes and line feeds encoded, and a binary part keeps its
// bytes.

const form = new FormData();
form.append(`a"b\nc\r\nd`, "v1\r\nv2");
form.append("bin", new File([new Uint8Array([0, 1, 255])], `f"q.txt`, { type: "application/x-bin" }));
const request = new Request("http://example.com/", { method: "POST", body: form });
const type = request.headers.get("content-type");
const boundary = /boundary=(.*)/.exec(type)[1];
const bytes = new Uint8Array(await request.arrayBuffer());
console.log(type.replace(boundary, "~"));
console.log(JSON.stringify(new TextDecoder("latin1").decode(bytes).split(boundary).join("~")));
