// The multipart boundary is drawn at random for every body: two requests
// over the same form carry different boundaries, each with undici's shape,
// and a part whose text spells a boundary-like string still encodes as one
// part (the boundary is checked against the parts and redrawn on a
// conflict).

const form = new FormData();
form.append("a", "----formdata-undici-01234567890");
form.append("b", "plain");
const one = new Request("http://example.com/", { method: "POST", body: form });
const two = new Request("http://example.com/", { method: "POST", body: form });
const typeOne = one.headers.get("content-type");
const typeTwo = two.headers.get("content-type");
const boundaryOne = /boundary=(.*)/.exec(typeOne)[1];
console.log("shape", /^multipart\/form-data; boundary=----formdata-undici-0\d{11}$/.test(typeOne));
console.log("distinct", boundaryOne !== /boundary=(.*)/.exec(typeTwo)[1]);
const text = new TextDecoder().decode(new Uint8Array(await one.arrayBuffer()));
console.log("parts", text.split("--" + boundaryOne).length - 1, text.includes("----formdata-undici-01234567890"));
