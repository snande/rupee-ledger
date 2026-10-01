// Maps the free-text note of an entry (e.g. `masala chai`, `auto`) to a
// spend category by keyword. Pure: no DOM, no storage, no network, so it
// can run on every saved entry while the app is offline.

// Display order of the categories; `Other` catches everything unmatched.
export const CATEGORIES = Object.freeze([
  'Food',
  'Transport',
  'Shopping',
  'Bills',
  'Health',
  'Entertainment',
  'Other',
]);

// Lowercase single-word keywords per category. A keyword lives in exactly
// one category; when a note matches several categories, the first in
// `CATEGORIES` order wins.
const KEYWORDS = Object.freeze({
  Food: new Set([
    'chai', 'tea', 'coffee', 'lunch', 'dinner', 'breakfast', 'snacks',
    'samosa', 'biryani', 'zomato', 'swiggy',
  ]),
  Transport: new Set([
    'auto', 'rickshaw', 'cab', 'taxi', 'uber', 'ola', 'bus', 'metro',
    'train', 'petrol', 'diesel', 'fuel', 'parking',
  ]),
  Shopping: new Set([
    'amazon', 'flipkart', 'myntra', 'clothes', 'shirt', 'shoes', 'grocery',
    'groceries', 'kirana', 'dmart', 'vegetables', 'sabzi',
  ]),
  Bills: new Set([
    'electricity', 'rent', 'wifi', 'broadband', 'recharge', 'mobile',
    'phone', 'gas', 'water', 'emi', 'insurance', 'maintenance',
  ]),
  Health: new Set([
    'doctor', 'medicine', 'medicines', 'pharmacy', 'chemist', 'hospital',
    'clinic', 'gym', 'dentist', 'apollo',
  ]),
  Entertainment: new Set([
    'movie', 'movies', 'cinema', 'netflix', 'hotstar', 'prime', 'spotify',
    'concert', 'game', 'games', 'pvr',
  ]),
});

/**
 * @param {string} note  The note part of an entry, e.g. `Masala Chai`.
 * @returns {string}  One of `CATEGORIES`; `Other` when no whole word of the
 *   note (ignoring case) is a keyword, or when the note is empty.
 */
export function categorise(note) {
  if (typeof note !== 'string') return 'Other';

  const tokens = note.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const category of CATEGORIES) {
    const keywords = KEYWORDS[category];
    if (keywords && tokens.some((token) => keywords.has(token))) return category;
  }
  return 'Other';
}
