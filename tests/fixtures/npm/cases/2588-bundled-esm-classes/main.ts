// Classes a bundled ES module defines inside its lazy __esm initializer,
// one extending stream.Readable and one extending that class, compile as
// class declarations: the stored class values have no static
// representation for a runtime-provided base.
import { wrap } from "gtesmclass";

console.log("start");
wrap("body", (result) => console.log(result));
