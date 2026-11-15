// A package that fences at module initialization (`class … extends Promise`)
// runs in a Node island, and the coverage pass reloads the program to lower
// it with that island set. The reload keeps the --define values the analysis
// started with, so the report covers only the branch the value selects.
import { assistant } from "ni-sdk";

if (process.env.SCRIPTC_COVERAGE_DEFINE === "on") {
  console.log(assistant().role);
} else {
  console.log("untaken");
  console.log("also untaken");
}
