// The checked-dynamic lane of the same identity: the resolver's own Error is
// the object its socket 'error' listener receives.
"use strict";
const dgram = require("node:dgram");

const boom = new Error("no resolution");
boom.code = "ENOTFOUND";

const sock = dgram.createSocket({
  type: "udp4",
  lookup: (_address, _family, callback) => callback(boom, ""),
});
sock.on("error", (error) => {
  console.log("identity", error === boom, error.code, error.message);
  sock.close();
});
sock.on("close", () => {});
sock.bind(0, "127.0.0.1");
