// graceful-fs's reads of require('fs').constants: own-property probes for
// platform-specific flags and member reads through a stored binding.
var fs = require("fs");
var constants = fs.constants;
console.log(typeof constants.O_RDONLY, constants.O_RDWR, Object.prototype.hasOwnProperty.call(constants, "O_SYMLINK") === ("O_SYMLINK" in constants), typeof constants.hasOwnProperty);
console.log(Object.prototype.hasOwnProperty.call(constants, "S_IFREG"), constants.O_EXCL > 0, typeof require("fs").constants.S_IFLNK);
var names = Object.keys(constants).filter(function (k) { return k.indexOf("UV_DIRENT_") === 0; });
console.log(names.join(","), constants.NOT_A_CONSTANT);
