// A record input's port is the URL parser's port: the leading decimal
// digits, ended by the first other character and with the rest not part of
// the port. So "80?x", "80:", "80" and "80+" all match a pattern port of
// 80 (and a wildcard), "0x50" is port 0, and a value with no leading digit
// ("*", "  80 ") or a port past 65535 is not a port at all, which fails the
// match instead of matching a wildcard. A special scheme's default port is
// the empty port.

const any = new URLPattern({ hostname: "example.com", port: "*" });
const exact = new URLPattern({ hostname: "example.com", port: "80" });
for (const port of ["80?x", "80:", "80", "80+", "*", "  80 ", "0x50", "65535", "65536", "", "080"]) {
  const record = { hostname: "example.com", port };
  const matched = any.exec(record);
  console.log(
    JSON.stringify(port),
    any.test(record),
    exact.test(record),
    matched === null ? "null" : JSON.stringify(matched.port.input),
  );
}
const http = new URLPattern({ protocol: "http", hostname: "example.com", port: "*" });
for (const port of ["80", "080", "81", ""]) {
  const matched = http.exec({ protocol: "http", hostname: "example.com", port });
  console.log("http", JSON.stringify(port), matched === null ? "null" : JSON.stringify(matched.port.input));
}
