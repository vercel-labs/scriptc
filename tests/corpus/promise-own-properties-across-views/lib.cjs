exports.mark = function (p) { p.status = "pending"; return p; };
exports.read = function (p) { return p.status; };
