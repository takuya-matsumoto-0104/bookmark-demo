import { fetchWithTimeout, readLimitedBody } from "./fetch";

const TITLE_PATTERN = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
const MAX_TITLE_HTML_BYTES = 1024 * 1024;

export const decodeHtmlEntities = (value: string) =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'");

export const normalizeUrl = (value: string) => {
  const input = value.trim();

  if (!input) {
    throw new Error("URL is required.");
  }

  const url = new URL(input);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }

  url.hash = "";
  return url.toString();
};

export const extractTitle = (html: string) => {
  const match = html.match(TITLE_PATTERN);

  if (!match?.[1]) {
    return null;
  }

  const title = decodeHtmlEntities(match[1].replace(/\s+/g, " ").trim());
  return title.length > 0 ? title : null;
};

export const fetchPageTitle = async (url: string, fetcher: typeof fetch = fetch) => {
  const response = await fetchWithTimeout(url, fetcher, "text/html", 4000);
  if (!response) {
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !contentType.toLowerCase().includes("text/html")) {
    return null;
  }

  const body = await readLimitedBody(response, MAX_TITLE_HTML_BYTES);
  if (!body) {
    return null;
  }

  return extractTitle(new TextDecoder().decode(body));
};
