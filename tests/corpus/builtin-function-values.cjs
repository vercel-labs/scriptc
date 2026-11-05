const fs = require("node:fs");
const zlib = require("node:zlib");

// Module members read as values keep Node's own function names and lengths.
const functions = { readFile: fs.readFile, createGzip: zlib.createGzip };
for (const key of Object.keys(functions)) {
  const fn = functions[key];
  console.log(key, fn.name, fn.length, typeof fn);
}

const readFile = fs.readFile;
const createGzip = zlib.createGzip;
console.log("aliases", readFile.name, readFile.length, createGzip.name, createGzip.length);

// A call through the value, then a stream built by the other value.
const path = "tests/fixtures/server/certs/localhost.pem";
const expected = fs.readFileSync(path, "utf8");
readFile(path, "utf8", (err, data) => {
  console.log("read", err === null, data === expected);
  const gzip = createGzip();
  const chunks = [];
  gzip.on("data", (chunk) => chunks.push(chunk));
  gzip.on("end", () => {
    const packed = Buffer.concat(chunks);
    const back = zlib.gunzipSync(packed);
    console.log("roundtrip", back.toString("utf8") === expected);
    // A function handed to another function keeps its identity.
    const seen = (fn) => fn.name + ":" + fn.length;
    console.log("passed", seen(fs.readFile), seen(zlib.createGzip));
  });
  gzip.end(Buffer.from(expected, "utf8"));
});
