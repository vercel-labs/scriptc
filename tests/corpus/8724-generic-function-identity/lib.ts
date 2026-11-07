// A generic function reached as a module-namespace member: the value is the
// declaration, which the importing program may also pin at a signature.
export function same<T>(value: T): T {
  return value;
}
