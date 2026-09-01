import { decodeHtmlEntities } from "./title";

const META_TAG_PATTERN = /<meta\b[^>]*>/gi;
const META_ATTRIBUTE_PATTERN = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g;

// Most sites use property="og:image", but name= and the :url suffix both appear in the wild.
const OG_IMAGE_KEYS = new Set(["og:image", "og:image:url"]);

const readAttributes = (tag: string) => {
  const attributes = new Map<string, string>();

  for (const match of tag.matchAll(META_ATTRIBUTE_PATTERN)) {
    const name = match[1].toLowerCase();
    // Browsers keep the first of a duplicated attribute, so malformed tags behave the same here.
    if (!attributes.has(name)) {
      attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
    }
  }

  return attributes;
};

export const extractOgImageUrl = (html: string, baseUrl: string) => {
  for (const [tag] of html.matchAll(META_TAG_PATTERN)) {
    const attributes = readAttributes(tag);
    const key = (attributes.get("property") ?? attributes.get("name") ?? "").trim().toLowerCase();

    if (!OG_IMAGE_KEYS.has(key)) {
      continue;
    }

    // Image URLs routinely carry query strings, so &amp; has to be unescaped before parsing.
    const content = decodeHtmlEntities(attributes.get("content") ?? "").trim();
    if (!content) {
      continue;
    }

    try {
      // og:image is allowed to be relative, so resolve it against the page it was found on.
      const resolved = new URL(content, baseUrl);
      // Reject data:, javascript: and other schemes before the value is ever fetched.
      return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.toString() : null;
    } catch {
      return null;
    }
  }

  return null;
};
