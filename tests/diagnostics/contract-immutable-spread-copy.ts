// A spread copies element values into a new array: spreading a shared
// `number[]` into an Immutable field is fine, because number elements cannot
// alias the source. Spreading an array of objects stays refused: the new
// array shares those objects, so only a fresh source may be spread.
import type { Immutable } from "@scriptc/types";

const shared: number[] = [1, 2, 3];
const sharedObjects: { n: number }[] = [{ n: 1 }];

class Config {
  values: Immutable<number[]> = [];
  objects: Immutable<{ n: number }[]> = [];
}

const config = new Config();
config.values = [...shared];
config.objects = [...sharedObjects];
sharedObjects[0]!.n = 4;
console.log(config.values.length, config.objects.length);
