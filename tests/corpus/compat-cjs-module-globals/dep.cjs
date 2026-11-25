// A sibling CommonJS module: its exports object and its own __filename.
exports.name = "dep";
exports.twice = (n) => n * 2;
exports.where = __filename;
