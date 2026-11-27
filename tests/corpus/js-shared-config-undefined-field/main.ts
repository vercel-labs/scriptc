import { settings } from './config.js';

function run(): void {
  console.log(settings.endpoint);
  console.log(JSON.stringify(settings.browser));
  console.log(Object.keys(settings).join(','));
}
run();
