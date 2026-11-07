// @requires-libnode
// Awaiting an island promise that is an instance of a Promise subclass
// goes through its own `then`, as `await` does in JavaScript: a request
// promise whose constructor does not take an executor and whose `then`
// starts the request resolves with the request's result.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
console.log("awaited", JSON.stringify(await lib.request({ n: 1 }, 2)), lib.log());
console.log("awaited by island code", await lib.awaitIt(lib.request("two", 2)), lib.log());
try {
  await lib.failing("request failed", 2);
} catch (e) {
  console.log("rejected", e.message, lib.log());
}
const all = await Promise.all([lib.request("a", 4), lib.request("b", 2), lib.plain("c")]);
console.log("all", all.join(","), lib.log());
const chained = await lib.request(20, 2).then((v) => v + 1);
console.log("then", chained, lib.log());
console.log("tagged", await lib.tagged("t"), lib.log());
console.log("plain", await lib.plain("p"), lib.log());

