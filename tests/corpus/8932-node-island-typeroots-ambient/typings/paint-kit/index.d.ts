// The project's typings for a package that ships none, found through
// `typeRoots` and named in `types`: every type is declared in the block of
// the module that exports it.
declare module "paint-kit/lib/core.js" {
  export interface PaintTone {
    open: string;
    close: string;
  }
  export interface PaintResult {
    value: string;
    tone: string;
    length: number;
  }
  export interface PaintKit {
    register(name: string, tone: (kit: PaintKit) => PaintTone): void;
    paint(text: string, options: { tone: string }): PaintResult;
    has(name: string): boolean;
    tone(name: string): PaintTone | undefined;
    list(): string[];
  }
  const kit: PaintKit;
  export default kit;
}

declare module "paint-kit/lib/index.js" {
  import kit from "paint-kit/lib/core.js";
  export default kit;
}

declare module "paint-kit/lib/tones/*.js" {
  import type { PaintKit, PaintTone } from "paint-kit/lib/core.js";
  const tone: (kit: PaintKit) => PaintTone;
  export default tone;
}
