// An import cycle whose class is constructed in the other module only from
// functions that run after both modules settled.
import { makeDog } from "./dogs.ts";
import { Pet } from "./pets.ts";

const ace = makeDog("ace");
console.log(makeDog("rex").speak(), ace instanceof Pet);
