// An implicit-any package function specialized for a string argument indexes
// the string (`base?.[0]`), as hono's mergePath does.
import { App, mergePath } from "merge-path";
console.log(new App().request("x"));
console.log(new App().request(new URL("http://h/p")));
console.log(new App().basePath("/api").basePath("v1/")._basePath);
console.log(mergePath("/api/", "/"), mergePath("a", "b", "/c"));
console.log(new App().basePath("").basePath("").request(""));
console.log(mergePath("", "x"), mergePath("/", "/"), mergePath("//", "y/"));
