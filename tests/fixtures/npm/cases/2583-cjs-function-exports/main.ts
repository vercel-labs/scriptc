// CommonJS modules whose export object is one of their own functions:
// semver 5/6's `exports = module.exports = Version` with members attached
// through both `exports` and `module.exports` (and read back through
// `exports` inside the module), and a constructor function exported whole
// with function and value members attached afterwards.
import Version from "gtfnexports";
import Point from "gtfnmembers";

const v = Version.parse("2.4.1");
console.log(v === null ? "null" : v.major(), String(new Version("3.0.0")));
console.log(Version.compare("5.0.0", "3.2.0"), Version.gt("1.0.0", "2.0.0"), Version.MAX_LENGTH);
console.log(Point.origin().sum(), new Point(2, 3).sum(), Point.dimensions);
