// process.release: the compatibility target's release metadata, one stable
// object with Node's four fields. The download URLs name the same release
// process.versions.node reports, so a program that builds a download URL
// from either field gets the one Node built in.
const release = process.release;
console.log("object", typeof release, release !== null, release === process.release);
console.log("name", release.name, typeof release.name);
console.log("lts", release.lts, typeof release.lts);
console.log("keys", Object.keys(release).join(","));
const node = process.versions.node;
console.log("source", release.sourceUrl === `https://nodejs.org/download/release/v${node}/node-v${node}.tar.gz`);
console.log("headers", release.headersUrl === `https://nodejs.org/download/release/v${node}/node-v${node}-headers.tar.gz`);
console.log("same-release", release.headersUrl === release.sourceUrl.replace(".tar.gz", "-headers.tar.gz"));
const { name } = release;
console.log("stored", name === "node", typeof release.sourceUrl, release.sourceUrl.startsWith("https://"));
