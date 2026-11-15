// @requires-libnode
// What an island module knows about its own place: import.meta.url,
// dirname and filename, import.meta.resolve, __dirname and __filename,
// module.id, parent and children, require.cache, require.resolve with and
// without `paths`, and a file the package reads beside itself.
import { where as whereCommon } from "pathcjs";
import { where as whereModule } from "pathesm";

console.log(whereModule());
console.log(whereCommon());
