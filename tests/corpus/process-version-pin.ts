// process.version and process.versions.node name the pinned Node release
// the runtime's behavior is verified against.
console.log(process.version, process.versions.node);
console.log(process.version === `v${process.versions.node}`);
const [major] = process.versions.node.split(".");
console.log(Number(major) >= 24);
