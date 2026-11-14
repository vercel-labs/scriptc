// setHeader/appendHeader over an array argument. The elements' toString runs
// during validation and again during conversion, and that hook is program
// code: one element's toString can empty the array, replace a later element,
// or swap in a CRLF payload. Each call therefore retains a snapshot of the
// elements, converts and validates exactly those lines, and stores those same
// lines — so a mutation during the call can neither change the header nor put
// text on the wire that validation never saw. The harness test pins that
// output; Node stores the raw array instead and converts at write time, which
// is the eager-vs-lazy difference this runtime's header store already
// documents.
import * as http from "node:http";

function replacing() {
  const array = [];
  array.push(
    {
      toString() {
        array[1] = "replaced";
        return "head";
      },
    },
    "second",
    "third",
  );
  return array;
}

function replacingWithCrlf() {
  const array = [];
  array.push(
    {
      toString() {
        array[1] = "evil\r\nx-injected: 1";
        return "first";
      },
    },
    "second",
  );
  return array;
}

const request = http.request({ host: "127.0.0.1", port: 1, path: "/", method: "GET" });
request.on("error", () => {});
request.setHeader("x-set", replacing());
request.appendHeader("x-set", replacing());
request.appendHeader("x-new", replacing());
console.log("set", JSON.stringify(request.getHeader("x-set") ?? null));
console.log("new", JSON.stringify(request.getHeader("x-new") ?? null));
request.destroy();

const server = http.createServer((incoming, outgoing) => {
  incoming.resume();
  let outcome = "ok";
  try {
    outgoing.setHeader("x-snapshot", replacingWithCrlf());
    outgoing.appendHeader("x-snapshot", replacingWithCrlf());
  } catch (error) {
    outcome = String(error.code ?? error.name);
  }
  console.log("response set", outcome);
  outgoing.end("done");
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  http.get({ host: "127.0.0.1", port, path: "/" }, (response) => {
    response.resume();
    const names = [];
    let injected = false;
    for (let i = 0; i < response.rawHeaders.length; i += 2) {
      const name = response.rawHeaders[i];
      const lower = name.toLowerCase();
      if (lower === "x-injected") injected = true;
      if (lower.startsWith("x-")) names.push(name + "=" + response.rawHeaders[i + 1]);
    }
    console.log("raw", JSON.stringify(names));
    console.log("injected", injected);
    response.on("end", () => server.close());
  });
});
