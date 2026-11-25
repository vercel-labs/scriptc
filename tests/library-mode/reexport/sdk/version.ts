export function version(): string {
  return "sdk-1.0";
}

// Not a function: a star re-export carries it too, and naming it in the
// profile is an honest SC4002 rather than a silent success.
export const vendor = "scriptc";
