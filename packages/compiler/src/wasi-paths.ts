import { tmpdir } from "node:os";
import { posix, win32 } from "node:path";

export type HostPathFlavor = "posix" | "win32";

/** Translate a host path into the namespace exposed by scriptc's WASI
 * runner. The caller's working tree is guest `/`; the host temp directory
 * is guest `/tmp`. Paths outside both capabilities have no guest spelling. */
export function wasiGuestPath(
  hostPath: string,
  cwd: string = process.cwd(),
  hostTmp: string = tmpdir(),
  flavor: HostPathFlavor = process.platform === "win32" ? "win32" : "posix",
): string | null {
  const host = flavor === "win32" ? win32 : posix;
  const absolute = host.resolve(hostPath);

  const under = (hostRoot: string, guestRoot: string): string | null => {
    const relative = host.relative(host.resolve(hostRoot), absolute);
    if (relative === "") return guestRoot;
    if (
      relative === ".." ||
      relative.startsWith(`..${host.sep}`) ||
      host.isAbsolute(relative)
    ) {
      return null;
    }
    return posix.join(guestRoot, relative.split(host.sep).join("/"));
  };

  return under(cwd, "/") ?? under(hostTmp, "/tmp");
}
