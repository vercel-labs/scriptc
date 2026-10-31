// Node islands, report-only: one npm package per island class, a package
// that runs inside an island's closure, one reached from both sides, and
// one that stays native. Coverage reports the islands a build would
// choose; the build itself is unchanged.
import { describe } from "ni-gap";
import { compile } from "ni-eval";
import { Counter } from "ni-ctor";
import { shout } from "ni-bundled";
import { twice } from "ni-typed";

console.log(describe());
console.log(compile("a + 1")(2));
const counter = new Counter();
counter.add(twice(2));
console.log(counter.total());
console.log(shout("hi"));
