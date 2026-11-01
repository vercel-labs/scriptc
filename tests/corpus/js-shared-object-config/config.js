import { Browsers } from './browser.js';
export const settings = {
  browser: Browsers.macOS('Chrome'),
  endpoint: 'wss://example.invalid',
  auth: undefined,
};
export const alias = settings;
export function update(endpoint) { settings.endpoint = endpoint; }
export function read() { return settings; }
