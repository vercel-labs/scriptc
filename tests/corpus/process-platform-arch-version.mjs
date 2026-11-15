// process.arch, process.platform and process.version: the values feature
// tests branch on. Each is a stable string that names the world the
// program runs in, and process.version is the release process.versions.node
// reports (the compiled binary answers the pinned compatibility target).
const arch = process.arch;
const platform = process.platform;
const version = process.version;
console.log("arch", typeof arch, arch.length > 0, arch === process.arch);
console.log("arch-known", ["x64", "arm64", "arm", "ia32", "ppc64", "s390x", "loong64", "riscv64", "mips64el", "wasm32", "wasm64"].includes(arch));
console.log("platform", typeof platform, platform.length > 0, platform === process.platform);
console.log("platform-known", ["linux", "darwin", "win32", "freebsd", "openbsd", "aix", "sunos", "android", "wasi"].includes(platform));
console.log("version", typeof version, /^v\d+\.\d+\.\d+$/.test(version), version === process.version);
console.log("version-node", version === `v${process.versions.node}`);
console.log("version-parts", version.slice(1).split(".").map((part) => /^\d+$/.test(part)).join(","));
console.log("version-major", Number(version.slice(1).split(".")[0]) >= 24);
// The spelled members through a stored reference.
const held = process;
console.log("stored", held.platform === platform, held.arch === arch, held.version === version);
console.log("branch", platform === "linux" ? "posix" : platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "other");
