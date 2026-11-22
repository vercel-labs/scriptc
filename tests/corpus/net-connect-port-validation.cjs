// connect's port ladder: net.connect and socket.connect both refuse a port
// that is not an integer in 0..65535 before anything dials, with Node's
// ERR_SOCKET_BAD_PORT message naming the received value.
"use strict";
const net = require("node:net");

const attempt = (label, fn) => {
  try {
    fn();
    console.log(label, "no throw");
  } catch (error) {
    console.log(label, error.code, error.message);
  }
};

attempt("net 70000", () => net.connect(70000, "127.0.0.1"));
attempt("net -1", () => net.connect(-1, "127.0.0.1"));
attempt("net 1.5", () => net.connect(1.5, "127.0.0.1"));
attempt("net NaN", () => net.connect(NaN, "127.0.0.1"));
attempt("socket 70000", () => new net.Socket().connect(70000, "127.0.0.1"));
attempt("socket 1.5", () => new net.Socket().connect(1.5, "127.0.0.1"));
