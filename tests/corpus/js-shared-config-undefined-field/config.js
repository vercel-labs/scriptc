import { Browsers } from './browser.js';
// The inferred record holds an `any[]` field and an `undefined` field, so it
// has no checked-native layout. The exported object is still one shared
// checked-dynamic global: the TypeScript importer reads the endpoint instead
// of refusing the binding.
export const settings = {
  browser: Browsers.macOS('Chrome'),
  endpoint: 'wss://example.invalid',
  auth: undefined,
};
