// A record returned across an npm package boundary keeps the members of
// whichever literal shape the callee built, including members only one
// shape has (#1314).
import { Dispatcher, describe } from "rpc-replies";

const d = new Dispatcher();
const summed = await d.dispatch({ id: 1, method: "sum", args: [1, 2, 3] });
console.log(JSON.stringify(summed), describe(summed));
const missing = await d.dispatch({ id: 3, method: "missing" });
console.log(JSON.stringify(missing), describe(missing));
console.log(Object.keys(missing).join(","), "failure" in missing, missing.failure?.code);
for (const call of [
  { id: "two", method: "echo", args: ["x"] },
  { id: 4, method: "other" },
]) {
  const reply = await d.dispatch(call);
  console.log(JSON.stringify(reply), Object.keys(reply).join(","), describe(reply));
}
const rejected = await d.reject(5, "bad params");
console.log(JSON.stringify(rejected), describe(rejected));
console.log(JSON.stringify(d.replyNow({ id: 6, method: "sum" })), JSON.stringify(d.replyNow({ id: 7, method: "x" })));
