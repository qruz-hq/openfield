import en from "./en.json";
import { numberFormat } from "./locale";

// One catalogue for every string a person sees (§2.12). Messages use a small ICU subset:
// {name}, {n, plural, =0 {…} one {# thing} other {# things}}, {n, selectordinal, …} and
// {x, select, a {…} other {…}}. An apostrophe before a brace quotes it, as in ICU.

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type Catalogue = typeof en;
export type MessageKey = Leaves<Catalogue>;
export type MessageValue = string | number;
export type MessageVars = Record<string, MessageValue>;

type Part =
  | { kind: "text"; text: string }
  | { kind: "arg"; name: string }
  | { kind: "hash" }
  | { kind: "plural"; name: string; ordinal: boolean; options: Map<string, Part[]> }
  | { kind: "select"; name: string; options: Map<string, Part[]> };

function flatten(tree: unknown, prefix: string, out: Map<string, string>): Map<string, string> {
  for (const [key, value] of Object.entries(tree as Record<string, unknown>)) {
    const path = prefix + key;
    if (typeof value === "string") out.set(path, value);
    else flatten(value, `${path}.`, out);
  }
  return out;
}

const messages = flatten(en, "", new Map());
const parsed = new Map<string, Part[]>();

export function parseMessage(source: string): Part[] {
  let pos = 0;

  const fail = (why: string): never => {
    throw new SyntaxError(`${why} at ${pos} in "${source}"`);
  };

  const skipSpace = () => {
    while (pos < source.length && /\s/.test(source[pos]!)) pos++;
  };

  const readWord = (): string => {
    skipSpace();
    const start = pos;
    while (pos < source.length && !/[\s,{}]/.test(source[pos]!)) pos++;
    return source.slice(start, pos);
  };

  const nodes = (inPlural: boolean, nested: boolean): Part[] => {
    const out: Part[] = [];
    let text = "";
    const flush = () => {
      if (text) out.push({ kind: "text", text });
      text = "";
    };
    while (pos < source.length) {
      const ch = source[pos]!;
      if (ch === "'") {
        const next = source[pos + 1];
        if (next === "'") {
          text += "'";
          pos += 2;
        } else if (next === "{" || next === "}" || (inPlural && next === "#")) {
          const end = source.indexOf("'", pos + 1);
          text += source.slice(pos + 1, end < 0 ? source.length : end);
          pos = end < 0 ? source.length : end + 1;
        } else {
          text += ch;
          pos++;
        }
      } else if (ch === "{") {
        flush();
        out.push(argument(inPlural));
      } else if (ch === "}") {
        if (!nested) fail("Unexpected }");
        break;
      } else if (ch === "#" && inPlural) {
        flush();
        out.push({ kind: "hash" });
        pos++;
      } else {
        text += ch;
        pos++;
      }
    }
    flush();
    return out;
  };

  const argument = (inPlural: boolean): Part => {
    pos++; // {
    const name = readWord();
    if (!name) fail("Missing argument name");
    skipSpace();
    if (source[pos] === "}") {
      pos++;
      return { kind: "arg", name };
    }
    if (source[pos] !== ",") fail("Expected , or }");
    pos++;
    const type = readWord();
    skipSpace();
    if (type !== "plural" && type !== "selectordinal" && type !== "select") fail(`Unknown type "${type}"`);
    if (source[pos] !== ",") fail("Expected ,");
    pos++;
    const options = new Map<string, Part[]>();
    for (;;) {
      skipSpace();
      if (source[pos] === "}") {
        pos++;
        break;
      }
      const selector = readWord();
      if (!selector) fail("Missing selector");
      skipSpace();
      if (source[pos] !== "{") fail("Expected {");
      pos++;
      options.set(selector, nodes(type === "select" ? inPlural : true, true));
      if (source[pos] !== "}") fail("Unclosed option");
      pos++;
    }
    if (!options.has("other")) fail(`"${name}" needs an other option`);
    return type === "select"
      ? { kind: "select", name, options }
      : { kind: "plural", name, ordinal: type === "selectordinal", options };
  };

  return nodes(false, false);
}

// Plural categories follow the catalogue's language; numbers follow the person's locale.
const cardinal = new Intl.PluralRules("en");
const ordinal = new Intl.PluralRules("en", { type: "ordinal" });
const formatNumber = (n: number) => numberFormat().format(n);

function render<T>(
  parts: Part[],
  vars: Record<string, unknown>,
  hash: number | undefined,
  out: (string | T)[],
) {
  const push = (value: string | T) => {
    const last = out[out.length - 1];
    if (typeof value === "string" && typeof last === "string") out[out.length - 1] = last + value;
    else out.push(value);
  };
  for (const part of parts) {
    switch (part.kind) {
      case "text":
        push(part.text);
        break;
      case "hash":
        push(hash === undefined ? "#" : formatNumber(hash));
        break;
      case "arg": {
        const value = vars[part.name];
        if (value === undefined) push(`{${part.name}}`);
        else if (typeof value === "number") push(formatNumber(value));
        else if (typeof value === "string") push(value);
        else push(value as T);
        break;
      }
      case "plural": {
        const n = Number(vars[part.name]);
        const rules = part.ordinal ? ordinal : cardinal;
        const branch =
          part.options.get(`=${n}`) ?? part.options.get(rules.select(n)) ?? part.options.get("other")!;
        render(branch, vars, n, out);
        break;
      }
      case "select": {
        const branch = part.options.get(String(vars[part.name])) ?? part.options.get("other")!;
        render(branch, vars, hash, out);
        break;
      }
    }
  }
}

function partsFor(key: string): Part[] | undefined {
  let parts = parsed.get(key);
  if (!parts) {
    const source = messages.get(key);
    if (source === undefined) return undefined;
    parts = parseMessage(source);
    parsed.set(key, parts);
  }
  return parts;
}

/** Look up a message and fill in its values. A missing key returns the key, so gaps show up. */
export function t(key: MessageKey, vars: MessageVars = {}): string {
  const parts = partsFor(key);
  if (!parts) return key;
  const out: string[] = [];
  render<string>(parts, vars, undefined, out);
  return out.join("");
}

/**
 * Like t(), but values may be anything (a link, an icon) and come back in place, so a sentence
 * with a component in the middle is still one message: tParts("firstRun.body", { openai: <Logo/> }).
 */
export function tParts<T>(key: MessageKey, vars: Record<string, MessageValue | T> = {}): (string | T)[] {
  const parts = partsFor(key);
  if (!parts) return [key];
  const out: (string | T)[] = [];
  render<T>(parts, vars, undefined, out);
  return out;
}

export const hasMessage = (key: string): key is MessageKey => messages.has(key);

/** Every key and raw message, for tests and tooling. */
export const allMessages = (): ReadonlyMap<string, string> => messages;
