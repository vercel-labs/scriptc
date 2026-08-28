// Differential test for URL.origin across various protocols and ports
const urls = [
  "https://example.com",
  "https://example.com/some/path?query=1#hash",
  "https://example.com:8080/api",
  "https://example.com:443/default-port",
  "http://example.com:80/default-port",
  "http://example.com:3000/dev",
  "ws://localhost:9000/ws",
  "wss://secure.ws.com/chat",
  "ftp://ftp.example.org:21/files",
  "ftp://ftp.example.org:2121/files",
  "file:///home/user/test.txt",
  "mailto:test@example.com",
];

for (const raw of urls) {
  const u = new URL(raw);
  console.log(raw + " -> " + u.origin);
}
