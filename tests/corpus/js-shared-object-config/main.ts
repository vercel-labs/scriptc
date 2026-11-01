import { settings, alias, read, update } from './config.js';
function run() {
  console.log(settings.endpoint);
  console.log(settings.browser.join('/'));
  console.log(settings.auth === undefined);
  console.log(settings === alias, read() === settings);
  update('wss://changed.invalid');
  console.log(alias.endpoint, read().endpoint);
  console.log(Object.keys(settings).join(','));
}
run();
