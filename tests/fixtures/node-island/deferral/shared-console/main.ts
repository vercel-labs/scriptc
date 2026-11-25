// `token-reader` copies SCRIPTC_BUILD_SECRET into a member of `console`, and
// `token-echo` exports that member. Neither the build-time value nor a
// snapshot computed after the reader's load is written into the program.
import { READY } from "token-reader";
import { TOKEN } from "token-echo";

console.log(READY, TOKEN === undefined ? "unset" : TOKEN);
