// fs.readdir's callback form validates `encoding` the way getOptions does:
// only a truthy value is checked, a falsy one is the default utf8, and every
// truthy value that is not an encoding name — a number or an object as much
// as a misspelt string — is Node's ERR_INVALID_ARG_VALUE thrown at the call
// rather than delivered to the callback. Repeated Dirent and Buffer listings
// must also leave no native entry storage behind (the sanitized lane's
// reference-count audit is what sees it).
//
// The matrix stops at numbers, booleans and strings: Node renders an object
// or array encoding in full (`Received {}`), while this runtime's diagnostic
// prints its bounded placeholder, so those two values cannot match byte for
// byte; both still throw the right error at the call.
const fs = require("node:fs");

const dir = fs.mkdtempSync("/tmp/scr-readdir-encoding-");
fs.writeFileSync(dir + "/a.txt", "a");
fs.writeFileSync(dir + "/b.txt", "b");

const label = (value) => {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object") return "{}";
  return String(value);
};

const readdir = (options) =>
  new Promise((resolve, reject) => {
    fs.readdir(dir, options, (err, names) =>
      err ? reject(err) : resolve(names),
    );
  });

const shape = (names) => {
  const first = names[0];
  const kind =
    typeof first === "string"
      ? "string"
      : Buffer.isBuffer(first)
        ? "Buffer"
        : String(first);
  return `${Array.isArray(names)} ${names.length} ${kind}`;
};

const values = [
  undefined,
  null,
  "",
  0,
  false,
  "utf8",
  "buffer",
  123,
  true,
  "bogus",
];

async function validation() {
  for (const value of values) {
    try {
      const names = await readdir({ encoding: value });
      console.log(label(value), "->", shape(names));
    } catch (err) {
      console.log(label(value), "-> throw", err.constructor.name, err.code, err.message);
    }
  }
}

async function repeated(rounds) {
  for (let round = 0; round < rounds; round++) {
    const entries = await new Promise((resolve, reject) => {
      fs.readdir(dir, { withFileTypes: true }, (err, list) =>
        err ? reject(err) : resolve(list),
      );
    });
    if (entries.length !== 2 || typeof entries[0].name !== "string") throw new Error("types");
    const names = await new Promise((resolve, reject) => {
      fs.readdir(dir, { encoding: "buffer" }, (err, list) =>
        err ? reject(err) : resolve(list),
      );
    });
    if (names.length !== 2 || !Buffer.isBuffer(names[0])) throw new Error("buffer");
  }
  console.log("rounds", rounds);
}

(async () => {
  await validation();
  await repeated(60);
  fs.rmSync(dir, { recursive: true, force: true });
})();
