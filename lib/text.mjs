// Rules for text an agent wrote before it is posted publicly.

const DASHES = new RegExp(`\\s*[${String.fromCharCode(0x2014, 0x2013)}]\\s*`, "g");
const ELLIPSIS = new RegExp(`${String.fromCharCode(0x2026)}|\\.{3,}`, "g");

/**
 * No pings, no HTML, no links outside the allowed prefixes, no em dashes or
 * ellipses, and a length cap that ends on a word. allowTags keeps named HTML
 * tags (release notes use details/summary); allowMentions keeps @handles that
 * are on the list (verified contributors). multiline keeps indentation and
 * fenced code untouched.
 */
export function sanitize(text, { maxLength = 700, allowLinks = ["https://github.com/"], allowTags = [], allowMentions = [], multiline = false } = {}) {
  const allowedLink = (url) => allowLinks.some((p) => url.startsWith(p));
  const tags = new Set(allowTags.map((t) => t.toLowerCase()));
  const mentions = new Set(allowMentions.map((m) => m.toLowerCase()));
  const parts = multiline ? String(text ?? "").split(/(```[\s\S]*?```)/g) : [String(text ?? "")];
  let t = parts.map((part) => {
    if (part.startsWith("```")) return part;
    let x = part.replace(/<!--[\s\S]*?-->/g, "");
    x = x.replace(/<\/?([a-z][a-z0-9]*)[^>]*>/gi, (m, tag) => (tags.has(tag.toLowerCase()) ? m : ""));
    x = x.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (m, label, url) => (allowedLink(url) ? m : label));
    x = x.replace(/https?:\/\/[^\s)]+/g, (url) => (allowedLink(url) ? url : ""));
    x = x.replace(/(^|[^\w`])@([\w-]+)/g, (m, pre, handle) => (mentions.has(handle.toLowerCase()) ? m : `${pre}${handle}`));
    x = x.replace(DASHES, ", ").replace(ELLIPSIS, ".").replace(/\s--\s/g, ", ");
    x = multiline ? x.replace(/(\S)[ \t]{2,}/g, "$1 ") : x.replace(/[ \t]+/g, " ");
    return x;
  }).join("");
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  if (t.length > maxLength) t = `${t.slice(0, maxLength).replace(/\s+\S*$/, "")}.`;
  return t;
}

/** Long-form agent text (PR bodies, release notes): multi-line, indentation and code kept. */
export function sanitizeLong(text, opts = {}) {
  return sanitize(text, { maxLength: 60000, multiline: true, ...opts });
}

export function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in values ? String(values[k]) : m));
}

export function quote(text) {
  return String(text ?? "").split("\n").map((l) => `> ${l}`).join("\n");
}

export function sentence(...parts) {
  return parts.map((p) => (p ?? "").trim()).filter(Boolean).join(" ");
}

/** Glob match for config path lists: ** spans directories, * stays in one. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(file, globs) {
  return globs.some((g) => globToRegExp(g).test(file));
}
