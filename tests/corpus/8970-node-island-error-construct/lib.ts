/** A ctor-less Error subclass: its effective constructor is Error's. */
export class Coded extends Error {}

/** An explicit constructor with its own shape. */
export class Tagged extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** How the native side reads an error the island constructed. */
export function inspect(value: Error): string {
  return [
    value instanceof Error,
    JSON.stringify(value.message),
    value.name,
    String(value),
  ].join(" ");
}
