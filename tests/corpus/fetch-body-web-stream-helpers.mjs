// Fetch bodies reached only through untyped helpers, in a program that
// names none of the web stream classes: tee and for await in functions
// whose parameters have no type.
const decoder = new TextDecoder();
const split = (body) => body.tee();
const drain = async (stream) => {
  let out = "";
  for await (const chunk of stream) out += decoder.decode(chunk);
  return out;
};
const response = new Response("through helpers");
const [left, right] = split(response.body);
console.log("helpers", await drain(left), await drain(right), response.bodyUsed);
const request = new Request("http://example.com/", { method: "POST", body: "request helper", duplex: "half" });
console.log("request", await drain(request.body), request.bodyUsed);
