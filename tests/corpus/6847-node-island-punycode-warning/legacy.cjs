"use strict";
// Island code outside node_modules that loads punycode on first use: Node
// prints its DEP0040 deprecation warning at that call.
exports.toAscii = (domain) => require("punycode").toASCII(domain);
