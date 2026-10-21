// How an SO card number is shown. A fabric return grey has its own number series, so its number is
// shown with a prefix: FR-1, FR-2 ... (an SO card is just 1, 2 ...). The same number can exist in both
// series, so a screen must show the label, not the bare number.
const PREFIX = 'FR-';

/** "5" for an SO card, "FR-5" for a fabric return. */
const soLabel = (cardNo, isGreyReturn) => (cardNo === null || cardNo === undefined ? null : isGreyReturn ? `${PREFIX}${cardNo}` : String(cardNo));

/**
 * Search text -> { n, grey } or null.
 *   "5"            the number 5 in either series            { n: 5, grey: undefined }
 *   "FR-5", "fr5"  fabric return 5 only                     { n: 5, grey: true }
 */
function parseCardSearch(text) {
  const m = /^(?:(fr)[-\s]?)?(\d+)$/i.exec(String(text || '').trim());
  return m ? { n: Number(m[2]), grey: m[1] ? true : undefined } : null;
}

module.exports = { PREFIX, soLabel, parseCardSearch };
