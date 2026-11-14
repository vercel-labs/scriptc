// os.userInfo() options the way untyped JavaScript passes them: only an
// object carries an encoding, the encodings Node reads as its utf8 default
// (invalid names, non-strings, absent members), "buffer" for the Buffer
// form, and the non-object arguments Node accepts as no options at all.
const os = require("node:os");

const plain = os.userInfo();
console.log("keys", Object.keys(plain).join(","));
console.log(
  "types",
  typeof plain.uid,
  typeof plain.gid,
  typeof plain.username,
  typeof plain.homedir,
  plain.shell === null ? "null" : typeof plain.shell,
);

function same(label, value) {
  console.log(
    label,
    value.username === plain.username,
    value.homedir === plain.homedir,
    value.uid === plain.uid,
  );
}

same("no options", os.userInfo(undefined));
same("empty object", os.userInfo({}));
same("members ignored", os.userInfo({ bogus: 1, other: "x" }));
same("encoding utf8", os.userInfo({ encoding: "utf8" }));
same("quoted member", os.userInfo({ "encoding": "utf8" }));
same("undefined encoding", os.userInfo({ encoding: undefined }));
same("null encoding", os.userInfo({ encoding: null }));
console.log("number encoding", typeof os.userInfo({ encoding: 3 }).username);
console.log("bad encoding name", typeof os.userInfo({ encoding: "nope" }).username);
console.log("string argument", typeof os.userInfo("utf8").username);
console.log("null argument", typeof os.userInfo(null).username);
console.log("number argument", typeof os.userInfo(7).username);
const fromArray = os.userInfo([]);
console.log("array argument", typeof fromArray.username, Array.isArray(fromArray));

const buffered = os.userInfo({ encoding: "buffer" });
const upperBuffered = os.userInfo({ encoding: "Buffer" });
console.log(
  "buffer",
  Buffer.isBuffer(buffered.username),
  Buffer.isBuffer(buffered.homedir),
  Buffer.isBuffer(buffered.shell),
  typeof buffered.uid,
  typeof buffered.gid,
);
console.log(
  "buffer matches",
  buffered.username.toString("utf8") === plain.username,
  upperBuffered.username.toString("utf8") === plain.username,
);
console.log("buffer keys", Object.keys(buffered).join(","));

// A fresh record per call, and the fields are ordinary writable properties.
const first = os.userInfo();
const second = os.userInfo();
first.username = "changed";
console.log("fresh", second !== first, second.username === plain.username);
