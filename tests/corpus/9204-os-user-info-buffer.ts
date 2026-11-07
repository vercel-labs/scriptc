// os.userInfo({ encoding: 'buffer' }): the three string fields are Buffers
// with the same bytes, uid/gid stay numbers. Any other encoding literal (or
// an empty options object) answers the string record.
import * as os from "node:os";

const strings = os.userInfo();
const buffers = os.userInfo({ encoding: "buffer" });

console.log(typeof strings.username, typeof strings.homedir);
console.log(
  Buffer.isBuffer(buffers.username),
  Buffer.isBuffer(buffers.homedir),
  Buffer.isBuffer(buffers.shell),
);
console.log(buffers.username.toString() === strings.username);
console.log(buffers.homedir.toString() === strings.homedir);
console.log(buffers.shell.toString() === strings.shell);
console.log(buffers.uid === strings.uid, buffers.gid === strings.gid);
console.log(buffers.username.length === strings.username.length);
console.log(buffers.username[0] === strings.username.charCodeAt(0));

const utf8 = os.userInfo({ encoding: "utf8" });
console.log(typeof utf8.username, utf8.username === strings.username);
const empty = os.userInfo({});
console.log(typeof empty.username, empty.homedir === strings.homedir);

// Mutating the buffer does not disturb a later call's answer.
buffers.username[0] = 0;
console.log(os.userInfo({ encoding: "buffer" }).username.toString() === strings.username);
