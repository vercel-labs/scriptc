// Two packages share `token-cache`, which copies SCRIPTC_BUILD_SECRET when
// it evaluates. `first-pkg` deletes the variable after requiring it, so
// `second-pkg`'s own read finds it unset while its TOKEN export is the
// cached value. The build sees the variable set and outside publicEnv:
// neither package defers, and the value is not written into the program.
import { SEEN as firstSeen } from "first-pkg";
import { SEEN as secondSeen, TOKEN } from "second-pkg";

console.log(firstSeen, secondSeen, typeof TOKEN);
