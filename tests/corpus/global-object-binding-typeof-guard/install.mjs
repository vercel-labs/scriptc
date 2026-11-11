// The write that a reader in another module cannot see statically.
export function installDetector() {
  globalThis.Detector = function Detector() {
    return "detected";
  };
}
