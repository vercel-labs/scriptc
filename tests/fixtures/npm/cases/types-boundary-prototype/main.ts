// A user interface extending a package interface types values the
// package's constructors create with a prototype (effect's Request.tagged
// pattern): they stay JavaScript values, so the package still finds its
// prototype members when the value goes back to it.
import { run, tagged, type Req } from "reqtag";

interface Double extends Req<number> {
  readonly _tag: "Double";
  readonly value: number;
}
const Double = tagged<Double>("Double");
const request = Double({ value: 21 });
console.log(run(request), request.value * 2, request._tag);
