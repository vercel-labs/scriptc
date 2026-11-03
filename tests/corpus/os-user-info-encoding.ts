// os.userInfo({ encoding }): the three passwd strings come back encoded the
// way Node's binding hands the raw passwd bytes to StringBytes::Encode.
// 'buffer' stays the Buffer form, every other Buffer encoding re-encodes the
// text, and a spelling Node does not know reads as utf8.
import * as os from "node:os";

const plain = os.userInfo();
const raw = os.userInfo({ encoding: "buffer" });
const hex = os.userInfo({ encoding: "hex" });
const hexUpper = os.userInfo({ encoding: "HEX" });
const base64 = os.userInfo({ encoding: "base64" });
const base64url = os.userInfo({ encoding: "base64url" });
const latin1 = os.userInfo({ encoding: "latin1" });
const binary = os.userInfo({ encoding: "binary" });
const ascii = os.userInfo({ encoding: "ascii" });
const utf16le = os.userInfo({ encoding: "utf16le" });
const ucs2 = os.userInfo({ encoding: "ucs2" });

console.log("hex", hex.username, hex.homedir, hex.shell);
console.log("base64", base64.username, base64.homedir, base64.shell);
console.log("base64url", base64url.username, base64url.homedir, base64url.shell);
console.log("utf16le", utf16le.username, utf16le.homedir, utf16le.shell);

// Each encoding is the decoder Buffer#toString applies to the same passwd
// bytes, so the encoded record agrees with the Buffer record field by field.
console.log(
  hex.username === raw.username.toString("hex"),
  hex.homedir === raw.homedir.toString("hex"),
  hex.shell === raw.shell.toString("hex"),
);
console.log(
  base64.username === raw.username.toString("base64"),
  base64url.shell === raw.shell.toString("base64url"),
  utf16le.homedir === raw.homedir.toString("utf16le"),
  latin1.username === raw.username.toString("latin1"),
  ascii.username === raw.username.toString("ascii"),
);

// Aliases and letter case fold to the same decoder; a template literal
// with no substitutions names an encoding the same way a quoted string does.
const templated = os.userInfo({ encoding: `hex` });
console.log(hexUpper.username === hex.username, binary.username === latin1.username);
console.log(ucs2.shell === utf16le.shell, templated.username === hex.username);

// The passwd text survives a round trip through an encoding that carries
// every byte.
console.log(Buffer.from(hex.username, "hex").toString() === plain.username);
console.log(Buffer.from(base64.homedir, "base64").toString() === plain.homedir);
console.log(Buffer.from(base64url.homedir, "base64url").toString() === plain.homedir);

// A spelling Node does not know, an empty one, and an explicit utf8 all
// answer the plain text; uid and gid stay numbers in every form.
const unknown = os.userInfo({ encoding: "nope" });
const empty = os.userInfo({ encoding: "" });
const utf8 = os.userInfo({ encoding: "utf8" });
console.log(typeof unknown.username, unknown.homedir === plain.homedir);
console.log(empty.shell === plain.shell, utf8.username === plain.username);
console.log(
  typeof hex.uid,
  typeof hex.gid,
  hex.uid === plain.uid,
  utf16le.gid === plain.gid,
);

// Every named encoding answers strings; only 'buffer' answers Buffers.
console.log(
  typeof hex.username === "string",
  typeof utf16le.shell === "string",
  Buffer.isBuffer(hex.username),
);
