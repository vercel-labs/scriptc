// A package function whose JSDoc promises a Promise but that returns
// nothing when a callback is passed (bcryptjs's hash and compare). The
// call that falls through completes normally, as in Node.
import { hash } from "callback-hash";

hash("pw", 4, (err, value) => {
  console.log("callback", err, value);
});
console.log("promise", await hash("pw", "salt"));
