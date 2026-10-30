// util.inspect and console.log of URL values print Node's URL view: the
// URL's properties in its inspector's order, the live searchParams, and
// `URL {}` past the depth limit. URLSearchParams print their pairs, and
// [Object] past the depth limit.
import { inspect } from "node:util";

const url = new URL("https://user:pass@example.com:8080/a/b?x=1&y=2#h");
console.log(url);
console.log(inspect(url, { depth: 0 }));
console.log(inspect({ nested: { deeper: { url } } }, { depth: 1 }));
console.log(new URL("file:///tmp/x"), new URL("data:text/plain,hi"), new URL("http://[::1]:3000/"));
url.searchParams.append("z", "3");
console.log(inspect(url));
const params = new URLSearchParams("a=1&b=two&a=3");
console.log(params);
console.log(new URLSearchParams());
console.log(inspect({ params }, { depth: 0 }));
const long = new URLSearchParams();
for (let i = 0; i < 12; i++) long.append(`key${i}`, `value number ${i}`);
console.log({ long });
// Past the depth limit a URL prints as `URL {}` and URLSearchParams as
// [Object], nested or at a negative depth.
console.log(inspect({ a: { b: { c: url } } }), inspect(url, { depth: -1 }));
console.log(inspect({ a: { b: { c: params } } }), inspect(params, { depth: -1 }));
console.log(inspect({ a: url }, { depth: 0 }), inspect({ a: { b: url } }, { depth: 1 }));
