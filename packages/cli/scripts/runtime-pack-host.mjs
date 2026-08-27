import { release } from "node:os";

export function hostSupportsRuntimePack(
  platform = process.platform,
  architecture = process.arch,
  hostRelease = release(),
) {
  const darwinMajor = Number.parseInt(hostRelease.split(".", 1)[0] ?? "", 10);
  return platform === "darwin" && architecture === "arm64" && darwinMajor >= 24;
}
