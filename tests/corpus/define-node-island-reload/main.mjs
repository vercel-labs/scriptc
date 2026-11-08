// @requires-libnode
// @define: process.env.SCRIPTC_DEFINE_ISLAND_MODE="island"
// A build that reloads its frontend to enable a Node island keeps the
// --define values it started with: the executable sets the variable and
// compiles only the branch the value selects.
import { greet } from "island-greeting";

if (process.env.SCRIPTC_DEFINE_ISLAND_MODE === "island") {
  console.log("taken", greet("define"));
} else {
  console.log("untaken");
}
