console.log("lib: start");
const WIN = { SEP: "\\" };
const POSIX = { SEP: "/" };
function describe() {
  return "table";
}
module.exports = {
  scale(x) {
    return x * 10;
  },
  chars(win32) {
    return win32 === true ? WIN.SEP : POSIX.SEP;
  },
  get label() {
    return describe();
  },
  ...require("./more.js"),
  k: (console.log("lib: k entry"), 1),
};
console.log("lib: end");
