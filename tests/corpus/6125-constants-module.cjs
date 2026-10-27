// node:constants (deprecated in documentation only, so no warning): one
// frozen object merging os.constants' dlopen, errno, priority and signals
// groups with fs.constants and crypto.constants, in that order. Members
// read like the owning modules' constants, and a constant the platform
// lacks is absent (graceful-fs probes O_SYMLINK with hasOwnProperty).
const constants = require("constants");
const nodeConstants = require("node:constants");
const os = require("os");

console.log(typeof constants, Object.isFrozen(constants), constants === nodeConstants);
console.log(constants.O_RDONLY, constants.O_WRONLY, constants.O_RDWR);
console.log(constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC);
console.log(constants.S_IFMT, constants.S_IFREG, constants.S_IFDIR, constants.S_IRWXU);
console.log(constants.F_OK, constants.R_OK, constants.W_OK, constants.X_OK);
console.log(constants.COPYFILE_EXCL, constants.UV_FS_COPYFILE_FICLONE, constants.UV_DIRENT_DIR);
console.log(constants.SIGTERM === os.constants.signals.SIGTERM, constants.SIGINT);
console.log(constants.ENOENT === os.constants.errno.ENOENT, constants.EACCES);
console.log(constants.PRIORITY_HIGH, constants.PRIORITY_LOW, constants.RTLD_LAZY);
console.log(constants.TLS1_2_VERSION, constants.RSA_PKCS1_PADDING, typeof constants.defaultCoreCipherList);
console.log(constants.hasOwnProperty("O_SYMLINK") === ("O_SYMLINK" in constants));
console.log(constants.hasOwnProperty("O_RDWR"), "SIGKILL" in constants, "UV_UDP_REUSEADDR" in constants);
console.log(constants.hasOwnProperty("NOT_A_CONSTANT"), "dlopen" in constants, "errno" in constants);
const keys = Object.keys(constants);
console.log(keys.indexOf("RTLD_LAZY") < keys.indexOf("E2BIG"), keys.indexOf("E2BIG") < keys.indexOf("PRIORITY_LOW"));
console.log(keys.indexOf("PRIORITY_LOW") < keys.indexOf("SIGHUP"), keys.indexOf("SIGHUP") < keys.indexOf("O_RDONLY"));
console.log(keys.indexOf("O_RDONLY") < keys.indexOf("OPENSSL_VERSION_NUMBER"), keys.includes("POINT_CONVERSION_HYBRID"));
