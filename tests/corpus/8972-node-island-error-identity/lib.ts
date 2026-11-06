/** The identity question a Test262 assert.throws asks, answerable natively. */
export function identity(expected: unknown, run: () => unknown): void {
  try {
    run();
    console.log("no throw");
  } catch (thrown) {
    const value = thrown as { constructor: unknown; message: unknown; name: unknown };
    console.log(
      value.constructor === expected,
      thrown instanceof Error,
      String(value.name),
      String(value.message),
    );
  }
}
