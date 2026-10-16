// Turns the notes agent's decision into the release body. No model, no I/O.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeLong } from "../../lib/text.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The decision schema; headline becomes required when the project wants frontmatter. */
export function decisionSchema(cfg) {
  const schema = JSON.parse(fs.readFileSync(path.join(HERE, "schema.json"), "utf8"));
  if (cfg.release.notes.headline) schema.required = [...schema.required, "headline"];
  return schema;
}

/** Commit authors worth crediting: deduped, without the owner, bots or blanks. */
export function contributors(logins, owner) {
  const seen = new Set();
  for (const raw of logins ?? []) {
    const l = String(raw ?? "").trim();
    if (!l || l === "null" || /\[bot\]$/i.test(l) || l.toLowerCase() === String(owner ?? "").toLowerCase()) continue;
    seen.add(l);
  }
  return [...seen];
}

/** Problems with a decision, as strings. Empty means usable. */
export function checkDecision(decision, cfg) {
  const errors = [];
  if (!decision || typeof decision !== "object") return ["decision is not an object"];
  if (decision.skip) return errors;
  if (typeof decision.body !== "string" || !decision.body.trim()) errors.push("body is empty");
  if (cfg.release.notes.headline) {
    const h = decision.headline;
    if (!Array.isArray(h) || h.length < 1 || h.length > 6) errors.push("headline needs 1 to 6 items");
    else if (h.some((i) => typeof i !== "string" || !i.trim() || /[\r\n]/.test(i))) errors.push("headline items must be single-line strings");
  }
  return errors;
}

// Plain YAML scalars only when they cannot be read as anything else.
function yamlItem(item) {
  return /^[A-Za-z0-9][A-Za-z0-9 _\-/().,+]*$/.test(item) ? item : JSON.stringify(item);
}

/**
 * The final release body: optional headline frontmatter, then the sanitized
 * notes. Throws when the decision is unusable.
 */
export function buildBody({ decision, cfg, version, contributors: handles = [] }) {
  const errors = checkDecision(decision, cfg);
  if (decision?.skip) throw new Error("decision is skip; there is no body to build");
  if (errors.length) throw new Error(`release notes for ${version} rejected: ${errors.join("; ")}`);
  const body = sanitizeLong(decision.body, {
    allowLinks: ["https://github.com/", ...(cfg.release.notes.allow_links ?? [])],
    allowTags: ["details", "summary"],
    allowMentions: handles,
  });
  if (!body) throw new Error(`release notes for ${version} are empty after sanitizing`);
  if (!cfg.release.notes.headline) return `${body}\n`;
  const items = decision.headline.map((i) => i.trim());
  return `---\nheadline:\n${items.map((i) => `  - ${yamlItem(i)}`).join("\n")}\n---\n\n${body}\n`;
}
