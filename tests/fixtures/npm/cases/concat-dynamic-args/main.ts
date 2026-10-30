// concat of checked-dynamic values decides spreading at run time.
import { run } from "concat-dynamic";
console.log(run(JSON.stringify({ text: "desc", list: ["a", "b"] })));
