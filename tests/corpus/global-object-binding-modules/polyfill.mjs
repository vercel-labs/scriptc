// Installs the classes on the global object when it does not have them, the
// way a codec's Node polyfill does.
if (typeof globalThis.Frame === "undefined") {
  globalThis.Frame = class Frame {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

global.makeFrame = function (width, height) {
  return new Frame(new Uint8ClampedArray(width * height * 4), width, height);
};

export function frameArea(frame) {
  return frame.width * frame.height;
}
