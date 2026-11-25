// The project's own declarations for a package that ships none: global
// interfaces, and the modules that export values of them. The tsconfig
// includes this file, and no module imports it.
interface PaintTone {
  open: string;
  close: string;
}
interface PaintResult {
  value: string;
  tone: string;
  length: number;
}
interface PaintKit {
  register(name: string, tone: PaintToneFn): void;
  paint(text: string, options: { tone: string }): PaintResult;
  has(name: string): boolean;
  tone(name: string): PaintTone | undefined;
  list(): string[];
}
interface PaintToneFn {
  (kit: PaintKit): PaintTone;
}

declare module "paint-kit/lib/core.js" {
  const kit: PaintKit;
  export default kit;
}

declare module "paint-kit/lib/index.js" {
  const kit: PaintKit;
  export default kit;
}

declare module "paint-kit/lib/tones/*.js" {
  const tone: PaintToneFn;
  export default tone;
}
