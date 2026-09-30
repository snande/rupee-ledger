/*
 * The router's own fallbacks inside <main>: Not found for any hash it does
 * not know, with a plain way back to Today, and a screen error for a screen
 * that failed to open, with Try again.
 */

export function renderNotFound() {
  return `
    <section class="card not-found" aria-labelledby="not-found-heading">
      <h2 id="not-found-heading">Not found</h2>
      <p>There is no screen at this address. Your spends are safe on this phone.</p>
      <a class="not-found-link" href="#/today">Go to Today</a>
    </section>
  `;
}

export function renderScreenError() {
  return `
    <section class="card screen-error" role="alert" aria-labelledby="screen-error-heading">
      <h2 id="screen-error-heading">This screen did not open</h2>
      <p>Nothing is lost. Your spends stay on this phone. Try again, and if it keeps happening, reload the app.</p>
      <button type="button" class="button-secondary" data-action="reload-screen">Try again</button>
    </section>
  `;
}
