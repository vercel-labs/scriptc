// os.userInfo's encoding must be spelled in the options object at the call
// site. A getter computes the value while the program runs, and a setter
// after it completes the same accessor pair — the read still goes through
// the getter — so the record's shape is the program's to decide and the
// call fences. (A setter on its own reads as undefined and a method is a
// function value: both are the utf8 default at compile time.)
import * as os from "node:os";

const pair = os.userInfo({
  get encoding() {
    return "buffer" as const;
  },
  set encoding(_value: "buffer") {},
});
console.log(pair.username);

const getterOnly = os.userInfo({
  get encoding() {
    return "utf8" as const;
  },
});
console.log(getterOnly.username);
