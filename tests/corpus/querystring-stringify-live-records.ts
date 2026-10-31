// querystring.stringify over typed records with a custom encoder: each value
// is read from the record when the loop reaches its key, an array's length
// after the key is encoded, and each element as the loop reaches it.
import * as qs from "node:querystring";

const data: { k: string[]; m: string; n: string } = { k: ["a", "b", "c"], m: "kept", n: "last" };
console.log(
  "shrink",
  qs.stringify(data, undefined, undefined, {
    encodeURIComponent: (s: string) => {
      if (s === "a") data.k.splice(1);
      if (s === "k") data.m = "changed";
      return s;
    },
  }),
);

const grow: { k: string[] } = { k: ["a"] };
console.log(
  "grow",
  qs.stringify(grow, undefined, undefined, {
    encodeURIComponent: (s: string) => {
      if (s === "a") grow.k.push("z");
      return s;
    },
  }),
  grow.k.length,
);

const swap: { k: string[]; m: string[] } = { k: ["x"], m: ["one", "two"] };
console.log(
  "replace",
  qs.stringify(swap, undefined, undefined, {
    encodeURIComponent: (s: string) => {
      if (s === "m") swap.m = ["new"];
      if (s === "k") swap.m = ["first", "second", "third"];
      return s;
    },
  }),
);
