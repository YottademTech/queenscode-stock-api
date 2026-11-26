/** One line of text, trimmed, with runs of white space made single, cut to `maxLength`. */
export function clip(value: unknown, maxLength: number): string {
  return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function clipLines(value: unknown, maxLength: number): string {
  return tidyLines(String(value === undefined || value === null ? '' : value)).slice(0, maxLength);
}

/** Trims each line and drops empty ones, keeping the line breaks between them. */
export function tidyLines(text: string): string {
  return text.split(/\r?\n/).map((line) => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** YYYY-MM-DD, or YYYY-MM when a label shows only month and year. */
export function isDayOrMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/.test(value);
}

/** The calendar day of an instant in a time zone, as YYYY-MM-DD. */
export function isoDay(instant: Date, timeZone: string): string {
  // The Canadian English date form is YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

/**
 * True unless the digits are an EAN-8, UPC-A, EAN-13 or GTIN-14 whose last digit does not match
 * the others. Other lengths (shop or local codes) have no check digit to test.
 */
export function barcodeChecks(digits: string): boolean {
  if (![8, 12, 13, 14].includes(digits.length)) return true;
  const body = digits.slice(0, -1).split('').reverse();
  const sum = body.reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(digits.charAt(digits.length - 1));
}
