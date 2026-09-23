// Numbers and dates follow the person's own locale; undefined means "whatever the system uses".
// Tests and the server can pin it so output doesn't depend on the machine.

let locale: string | undefined;

export const formatLocale = (): string | undefined => locale;

export function setFormatLocale(next: string | undefined): void {
  locale = next;
}

const numberFormats = new Map<string, Intl.NumberFormat>();

export function numberFormat(options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = `${locale ?? ""}|${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, format);
  }
  return format;
}
