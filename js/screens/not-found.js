/*
 * Shown inside <main> for any hash the router does not know, with a plain
 * way back to Today.
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
