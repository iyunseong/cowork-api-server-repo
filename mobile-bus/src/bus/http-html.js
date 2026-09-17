// Small HTML/form helpers shared by the KOBUS and Tmoney clients.
// Ported 1:1 from the k-skill bus helpers (parse_form / attrs / strip_tags).
// The bus sites return server-rendered HTML, not JSON, so we scrape hidden
// form fields and onclick() arguments with the same regexes the verified
// Python helpers use.

const FORM_RE = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
const INPUT_RE = /<input\b([^>]+)>/gi;
const ATTR_RE = /([\w:-]+)=["']([^"']*)["']/g;
const TAG_RE = /<[^>]+>/g;

export function unescapeHtml(s) {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// {name: value} of every attribute in a tag fragment (keys lower-cased).
export function attrs(fragment) {
  const out = {};
  for (const m of String(fragment).matchAll(ATTR_RE)) out[m[1].toLowerCase()] = unescapeHtml(m[2]);
  return out;
}

export function stripTags(s) {
  return unescapeHtml(String(s).replace(/<!--[\s\S]*?-->/g, "").replace(TAG_RE, " "))
    .replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

// All <input name=… value=…> pairs of the form whose id or name matches.
// Returns an ordered array of [name, value] (duplicates preserved), or [].
export function parseForm(html, formId) {
  for (const m of String(html).matchAll(FORM_RE)) {
    const a = attrs(m[1]);
    if (a.id === formId || a.name === formId) {
      const fields = [];
      for (const im of m[2].matchAll(INPUT_RE)) {
        const ia = attrs(im[1]);
        if (ia.name) fields.push([ia.name, ia.value ?? ""]);
      }
      return fields;
    }
  }
  return [];
}

// Replace the value of `key` in an ordered field list (all occurrences);
// append if absent.
export function setField(fields, key, val) {
  let found = false;
  const out = fields.map(([k, v]) => (k === key ? ((found = true), [k, val]) : [k, v]));
  if (!found) out.push([key, val]);
  return out;
}

export function fieldsToObject(fields) {
  const o = {};
  for (const [k, v] of fields) o[k] = v;
  return o;
}

// Single-quoted JS args inside `fn(...)`: "'a','b'" -> ["a","b"] (handles \').
export function quotedArgs(argText) {
  return [...String(argText).matchAll(/'((?:\\'|[^'])*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
}
