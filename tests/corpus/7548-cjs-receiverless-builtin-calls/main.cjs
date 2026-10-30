"use strict";
// tsc and esbuild output: the __esModule stamp spelled { value: !0 }, and
// calls of builtin module functions without a receiver, (0, ns.member)(...).
const lib = require("./lib.cjs");
const dc = require("node:diagnostics_channel");
const util = require("node:util");
const os = require("node:os");
const path = require("node:path");
console.log(lib.label, lib.describe("cache", 3));
const metrics = (0, dc.channel)("cache:metrics");
console.log(metrics.name, metrics.hasSubscribers);
const seen = [];
dc.subscribe("cache:metrics", (message) => seen.push(message.key));
metrics.publish({ key: "a" });
console.log(seen.join(","), metrics.hasSubscribers);
const tracing = (0, dc.tracingChannel)("cache");
console.log(tracing.hasSubscribers);
console.log((0, util.inspect)({ a: [1, 2] }), (0, util.isDeepStrictEqual)([1], [1]));
console.log((0, path.join)("a", "b"), typeof (0, os.platform)());
