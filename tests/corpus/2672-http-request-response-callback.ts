// The options-object response callback is part of request(), not just the
// URL-string row. Exercise both clients against a released local port: the
// callback must compile even though connection refusal keeps it from firing.
import * as net from "node:net";
import * as http from "node:http";
import * as https from "node:https";

const probe = net.createServer();
probe.listen(0, () => {
  const port = probe.address().port;
  probe.close(() => {
    const plain = http.request(
      { hostname: "127.0.0.1", port, path: "/", method: "GET" },
      () => console.log("unexpected http response"),
    );
    plain.on("error", () => console.log("http refused"));
    plain.on("close", () => {
      const secure = https.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/",
          method: "GET",
          rejectUnauthorized: false,
        },
        () => console.log("unexpected https response"),
      );
      secure.on("error", () => console.log("https refused"));
      secure.end();
    });
    plain.end();
  });
});
