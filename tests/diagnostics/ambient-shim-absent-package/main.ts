// The ambient module passes on the declarations of a file in a package
// that is not installed. The project's tsc reports the imported member as
// missing, and so does the build.
import { stocked } from "missing-larder/shelves";
import * as oven from "oven-dial";

console.log(stocked("flour"), oven.gasMark(180));
