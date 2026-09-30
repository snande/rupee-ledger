/*
 * Entry point: wires the hash router to the frame in index.html, then sets up
 * offline use (service worker, persistent storage). Loaded as a module, so it
 * runs after the document is parsed.
 */

import { startRouter } from './router.js';
import { startOffline } from './sw-register.js';

startRouter({
  win: window,
  main: document.getElementById('screen'),
  links: [...document.querySelectorAll('.tab-bar .tab')],
});

startOffline();
