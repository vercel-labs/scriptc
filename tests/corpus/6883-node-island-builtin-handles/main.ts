// @requires-libnode
// Island values typed with builtin classes (URLSearchParams, Headers, URL)
// stay island handles: their members and methods run in the island, and
// passing them back hands the island its own object.
import { RequestLike, describeParams, makeParams } from "urlkit";

const request = new RequestLike("http://localhost/api/products?tag=software&limit=2", {
  "x-trace": "abc",
});
const tag = request.searchParams.get("tag") ?? "none";
const missing = request.searchParams.get("missing") ?? "none";
console.log("tag", tag, "missing", missing, "has limit", request.searchParams.has("limit"));
console.log("pathname", request.url.pathname, "host", request.url.host);
console.log("trace", request.headers.get("x-trace"), "absent", request.headers.get("x-absent"));

const params = request.searchParams;
params.append("page", "3");
console.log("described", describeParams(params));
console.log("round trip", describeParams(makeParams("a=1&b=two")));
console.log("same object", params === request.searchParams);
console.log("size", params.size);
