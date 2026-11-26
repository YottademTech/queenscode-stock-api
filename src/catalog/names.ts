// How products are told apart by name, and how a new product gets its code.

export function sameName(left: string, right: string): boolean {
  return normalizeName(left) === normalizeName(right);
}

function normalizeName(value: string): string {
  return String(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

type Named = { name: string; size: string };

/** The listed product a newly read label belongs to, if any: same name, and the same size where both say one. */
export function matchProductByName<T extends Named>(products: readonly T[], details: Named): T | null {
  const sized = details.size ? `${details.name} ${details.size}` : details.name;
  return products.find((product) =>
    (sameName(product.name, details.name) && (!product.size || !details.size || sameName(product.size, details.size)))
    || sameName(product.name, sized)) ?? null;
}

/** The longest a product name may be: the limit of the name field in DETAIL_FIELDS. */
const PRODUCT_NAME_MAX = 120;

/**
 * Product names are unique: a second size of a listed product gets its size added, with the name
 * cut short if needed to stay a valid name.
 */
export function uniqueProductName(products: readonly Named[], details: Named): string {
  const taken = products.some((product) => sameName(product.name, details.name));
  if (!taken || !details.size) return details.name;
  return `${details.name.slice(0, PRODUCT_NAME_MAX - 1 - details.size.length).trim()} ${details.size}`;
}

/** The start of a code that Google Sheets would read as a month, or as true or false. */
const MONTH_LIKE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|true|false)(-|$)/i;

/** "QBH Carrot Oil", "100ml" becomes QBHCO-100. Short all-capital words are kept whole. */
export function makeProductCode(name: string, size: string, takenCodes: readonly string[]): string {
  const letters = String(name).split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map((word) => (/^[A-Z0-9]{2,4}$/.test(word) ? word : word.charAt(0).toUpperCase()))
    .join('')
    .slice(0, 8);
  const sizeDigits = (String(size).match(/\d+/) ?? [''])[0];
  const plain = [letters || 'ITEM', sizeDigits].filter(Boolean).join('-');
  // Google Sheets turns text such as SEP-30, 12-5 or 1E5 into a date or a number as it is written,
  // and the product could then never be found by its code again. Such a code gets a letter in front.
  const base = /^\d/.test(plain) || MONTH_LIKE.test(plain) ? `P-${plain}` : plain;

  let code = base;
  for (let suffix = 2; takenCodes.includes(code); suffix++) code = `${base}-${suffix}`;
  return code;
}
