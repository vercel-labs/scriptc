import * as factories from "./pair.ts";
const pair = factories.Pair.make("value", 7);
const reverse = factories.Pair.make<number, string>(9, "other");
console.log(pair.first, pair.second, reverse.first, reverse.second);
console.log(factories.Pair.choose<number | undefined>(undefined, 4));
