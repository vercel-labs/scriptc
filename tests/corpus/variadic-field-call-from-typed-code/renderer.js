export class Renderer {
  constructor() {
    const bg = { setClearColor: function (color, alpha = 1) { return color + alpha; } };
    this.setClearColor = function () {
      return bg.setClearColor.apply(bg, arguments);
    };
  }
}
