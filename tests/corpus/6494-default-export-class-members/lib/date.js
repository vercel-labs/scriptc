// A class whose base scriptc cannot extend yet: the default export object
// below narrows this member away, and only reads of it would fence.
export class StampDate extends Date {
  constructor(text) {
    super(text);
    this.label = "stamp:" + text;
  }
}
