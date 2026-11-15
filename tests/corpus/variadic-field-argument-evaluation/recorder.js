export class Recorder {
  constructor() {
    this.record = function (value) {
      return [value, arguments[0], arguments.length];
    };
  }
}
