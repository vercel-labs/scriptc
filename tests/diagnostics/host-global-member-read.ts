// A member read off a Node 24 global native code does not provide: the
// constructor value carries name, length and prototype, and the members the
// class's own value would carry are surface native code does not have
// (SC2020, host-global), where Node answers them.
declare var FormData: {
  new (): unknown;
  readonly prototype: object;
  readonly OPEN: number;
};
console.log(FormData.OPEN);
