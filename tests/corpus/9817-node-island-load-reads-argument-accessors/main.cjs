// @requires-libnode
// Island packages whose load hands a locale-sensitive call an argument that
// only the package's own code can answer: an options object whose member is
// a getter, a proxy, a locale tag that is converted from an object. Each
// counts how often its code ran, or answers differently the second time.
// The build's load recorder classifies such a call before it runs; when it
// read the argument itself, the getter ran twice in the build, the call got
// the second answer, and the executable held that result as a constant.
// The recorder now looks at an argument only where the engine answers
// without running the load's code, and a load with an argument it cannot
// read that way evaluates where it is imported. An argument counts as
// readable only when nothing on it can run while the call reads it: the
// first package's arguments are plain data when the call starts, and its
// own getter or conversion takes the zone, or the list of tags, away
// before the call gets to them. It is loaded and read first, before
// anything has started Node, so that a recorded answer would be the one
// printed. Before it, a package whose load generates key pairs: the
// functions that make them were listed among those that compute from their
// arguments, so the executable carried the keys the build generated and
// every run answered with them. The keys themselves are printed only when
// asked, so that the program's output is the same in every run.
const keys = require("key-kit");
console.log("keys:", keys.publicKey.length, keys.groupKey.length);
if (process.env.SHOW_GENERATED_KEYS === "1") console.log("generated:", keys.publicKey, keys.groupKey);
const shifting = require("shifting-kit");
console.log("removed:", shifting.byGetter, shifting.byConversion, shifting.order);
const options = require("options-kit");
const tags = require("tags-kit");
const file = require("file-kit");

console.log("zone:", options.zone, options.reads);
console.log("time:", options.time, options.timeReads);
console.log("proxy:", options.proxied, options.gets);
console.log("number:", tags.number, tags.conversions);
console.log("order:", tags.order, tags.elementReads);
console.log("list:", tags.locale, tags.lengthReads);
console.log("file:", file.modified, file.reads);
