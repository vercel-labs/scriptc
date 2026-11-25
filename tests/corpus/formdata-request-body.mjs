// A FormData request body is Node's multipart/form-data encoding: the
// content type carries a boundary, each entry is a recorded part (string
// values with CRLF line feeds, Blob and File parts with their filename and
// type), and the body ends with the closing boundary. The boundary itself
// is random, so it is replaced with a placeholder before printing.

const form = new FormData();
form.append("a", "1");
form.append("name", `line\r\nbreak "q"`);
form.append("f", new File(["xy"], "f.txt", { type: "text/plain" }));
form.append("blob", new Blob(["zz"]));
const request = new Request("http://example.com/", { method: "POST", body: form });
const type = request.headers.get("content-type");
const boundary = /boundary=(.*)/.exec(type)[1];
console.log(type.replace(boundary, "~"));
const bytes = new Uint8Array(await request.arrayBuffer());
console.log(JSON.stringify(new TextDecoder().decode(bytes).split(boundary).join("~")));
const response = new Response(form);
console.log(response.headers.get("content-type").replace(/boundary=.*/, "boundary=~"));
