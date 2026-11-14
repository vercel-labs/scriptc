// setHeader/appendHeader over an array argument. The elements' toString runs
// during validation and again during conversion, and that hook is program
// code: one element's toString can empty the array or replace a later
// element. Each call therefore retains a snapshot of the elements and reads
// only that snapshot, so the header is what the call started with and no
// iteration dereferences a value the hook released. The harness test pins
// that output; Node stores the raw array instead and converts at write time,
// which is the eager-vs-lazy difference this runtime's header store already
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

const request = http.request({ host: "127.0.0.1", port: 1, path: "/", method: "GET" });
request.on("error", () => {});
request.setHeader("x-set", replacing());
request.appendHeader("x-set", replacing());
request.appendHeader("x-new", replacing());
console.log("set", JSON.stringify(request.getHeader("x-set") ?? null));
console.log("new", JSON.stringify(request.getHeader("x-new") ?? null));
request.destroy();
