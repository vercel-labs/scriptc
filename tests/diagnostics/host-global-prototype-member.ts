// A member read off the value's prototype object: Node's class provides its
// instance members there, which native code does not; the prototype carries
// the constructor link only (SC2020, host-global).
interface HostNavigator {
  hardwareConcurrency: number;
}
declare var Navigator: { new (): HostNavigator; readonly prototype: HostNavigator };
console.log(Navigator.prototype.hardwareConcurrency);
