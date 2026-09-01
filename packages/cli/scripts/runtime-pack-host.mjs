import { release } from "node:os";

export function hostSupportsRuntimePack(
  platform = process.platform,
  architecture = process.arch,
  hostRelease = release(),
) {
  const darwinMajor = Number.parseInt(hostRelease.split(".", 1)[0] ?? "", 10);
  return (platform === "darwin" && (architecture === "arm64" || architecture === "x64") && darwinMajor >= 24) ||
    (platform === "linux" && (architecture === "arm64" || architecture === "x64")) ||
    (platform === "win32" && architecture === "x64");
}
