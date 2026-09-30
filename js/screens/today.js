/*
 * The Today screen: the quick-entry card and the controls that are not
 * available until there are spends. Static markup for now; later
 * deliverables wire it to the ledger.
 */

export function renderToday() {
  return `
    <section class="card" aria-labelledby="add-heading">
      <h2 id="add-heading">Add a spend</h2>

      <div class="field">
        <label for="quick-entry">Quick entry</label>
        <input class="quick-entry" id="quick-entry" type="text" placeholder="120 chai" autocomplete="off" aria-describedby="quick-entry-preview">
        <p class="hint" id="quick-entry-preview"><span class="amount">₹120</span> · Tea &amp; snacks</p>
      </div>

      <div class="field">
        <label for="category">Category</label>
        <select id="category">
          <option>Tea &amp; snacks</option>
          <option>Groceries</option>
          <option>Travel</option>
          <option>Bills</option>
          <option>Other</option>
        </select>
      </div>

      <div class="field">
        <label for="note">Note</label>
        <textarea id="note" rows="3" placeholder="Anything to remember about this spend"></textarea>
      </div>

      <label class="choice" for="remember">
        <input id="remember" type="checkbox" checked>
        Remember this category for chai
      </label>

      <div class="button-row">
        <button type="button">Add</button>
        <button type="button" class="button-secondary">Export backup</button>
        <button type="button" class="button-destructive">Delete</button>
      </div>
    </section>

    <section class="card" aria-labelledby="disabled-heading">
      <h2 id="disabled-heading">Not available yet</h2>

      <div class="field">
        <label for="search-disabled">Search spends</label>
        <input id="search-disabled" type="search" placeholder="Add a spend first" disabled>
      </div>

      <div class="field">
        <label for="month-disabled">Compare month</label>
        <select id="month-disabled" disabled>
          <option>No spends this month yet</option>
        </select>
      </div>

      <div class="field">
        <label for="note-disabled">Backup note</label>
        <textarea id="note-disabled" rows="2" placeholder="No backup yet" disabled></textarea>
      </div>

      <div class="button-row">
        <button type="button" disabled>Import backup</button>
      </div>
    </section>
  `;
}
