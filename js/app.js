/*
 * Entry point: wires the hash router to the frame in index.html. Loaded as a
 * module, so it runs after the document is parsed.
 */

import { startRouter } from './router.js';

startRouter({
  win: window,
  main: document.getElementById('screen'),
  links: [...document.querySelectorAll('.tab-bar .tab')],
});
