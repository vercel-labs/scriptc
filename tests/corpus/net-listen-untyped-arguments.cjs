// server.listen with untyped arguments follows Node's normalizeArgs and
// validatePort: a function is the 'listening' callback on an unused port,
// undefined and null take an unused port, a numeric string is a port, and
// a port out of range or not an integer throws ERR_SOCKET_BAD_PORT, as a
// bad port in a connect options object checked at run time does.
"use strict";
const net = require("net");

// Values read from JSON are untyped, as a test helper's results are.
const raw = JSON.parse(
  '{"none":null,"zero":0,"text":"0","bad":[-1,65536,1.5,"","  ","70000"]}',
);
const wrap = (fn) => (...args) => fn(...args);
const forms = [
  ["callback only", (server, done) => server.listen(wrap(done))],
  ["undefined port", (server, done) => server.listen(raw.missing, done)],
  ["null port", (server, done) => server.listen(raw.none, done)],
  ["numeric string", (server, done) => server.listen(raw.text, done)],
  ["host and callback", (server, done) => server.listen(raw.zero, "127.0.0.1", done)],
];

function next(i) {
  if (i === forms.length) {
    for (const bad of raw.bad) {
      const server = net.createServer();
      try {
        server.listen(bad);
        console.log(JSON.stringify(bad), "listened");
        server.close();
      } catch (err) {
        console.log(JSON.stringify(bad), err.name, err.code, err.message);
      }
    }
    // A connect options object with a computed key is checked at run time.
    const key = ["po", "rt"].join("");
    try {
      net.connect({ [key]: -1 }).destroy();
      console.log("connect", "connected");
    } catch (err) {
      console.log("connect", err.name, err.code, err.message);
    }
    return;
  }
  const [label, listen] = forms[i];
  const server = net.createServer();
  listen(server, () => {
    const port = server.address().port;
    console.log(label, typeof port, port > 0);
    server.close(() => next(i + 1));
  });
}
next(0);
