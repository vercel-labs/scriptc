// A CommonJS require of the bare names resolves to the builtins too.
const { StringDecoder } = require("string_decoder");
exports.decodeEuro = () => {
  const d = new StringDecoder("utf8");
  return d.write(Buffer.from([0xe2, 0x82])) + d.end(Buffer.from([0xac]));
};
