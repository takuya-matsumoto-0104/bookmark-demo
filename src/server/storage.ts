import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchWithTimeout, readLimitedBody } from "./fetch";
import { extractOgImageUrl } from "./ogp";

const FETCH_TIMEOUT_MS = 5000;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const OGP_PUBLIC_PATH = "/ogp";

// Only formats a browser renders in an <img> tag; the extension is derived from the
// content-type rather than the URL so a mislabelled path cannot pick the file name.
const IMAGE_EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/avif", "avif"]
]);

// The reverse of IMAGE_EXTENSIONS, used when serving a file back from disk.
const OGP_CONTENT_TYPES = new Map([...IMAGE_EXTENSIONS].map(([contentType, extension]) => [extension, contentType]));

// storeOgpImage only ever writes <uuid>.<extension>, so a request that does not
// match this shape cannot name a file this server wrote. Matching first keeps
// path segments like ".." out of the join below entirely.
const OGP_FILE_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.([a-z]+)$/;

const readContentType = (response: Response) =>
  (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

const fetchPageHtml = async (pageUrl: string, fetcher: typeof fetch) => {
  const response = await fetchWithTimeout(pageUrl, fetcher, "text/html", FETCH_TIMEOUT_MS);
  if (!response || readContentType(response) !== "text/html") {
    return null;
  }

  const body = await readLimitedBody(response, MAX_HTML_BYTES);
  return body ? new TextDecoder().decode(body) : null;
};

export const storeOgpImage = async (
  pageUrl: string,
  storageDir: string,
  fetcher: typeof fetch = fetch
): Promise<string> => {
  // An OGP image is decoration, so every failure below returns "" and lets the
  // bookmark be saved anyway. Nothing in here is allowed to throw at the caller.
  try {
    const html = await fetchPageHtml(pageUrl, fetcher);
    if (!html) {
      return "";
    }

    const imageUrl = extractOgImageUrl(html, pageUrl);
    if (!imageUrl) {
      return "";
    }

    // fetchWithTimeout re-validates this URL, which matters because the remote page chose it.
    const response = await fetchWithTimeout(imageUrl, fetcher, "image/*", FETCH_TIMEOUT_MS);
    if (!response) {
      return "";
    }

    const extension = IMAGE_EXTENSIONS.get(readContentType(response));
    if (!extension) {
      return "";
    }

    // readLimitedBody returns null for an empty body and for anything past the cap.
    const image = await readLimitedBody(response, MAX_IMAGE_BYTES);
    if (!image) {
      return "";
    }

    // A random name keeps the remote URL out of the file system entirely.
    const fileName = `${crypto.randomUUID()}.${extension}`;
    await mkdir(storageDir, { recursive: true });
    await writeFile(join(storageDir, fileName), image);

    return `${OGP_PUBLIC_PATH}/${fileName}`;
  } catch {
    return "";
  }
};

export const deleteOgpImage = async (storageDir: string, publicPath: string) => {
  const prefix = `${OGP_PUBLIC_PATH}/`;
  const fileName = publicPath.startsWith(prefix) ? publicPath.slice(prefix.length) : "";
  if (!OGP_FILE_NAME_PATTERN.test(fileName)) {
    return;
  }

  try {
    await unlink(join(storageDir, fileName));
  } catch {
    // Cleanup is best-effort because a missing OGP image must not break bookmark writes.
  }
};

export const readOgpImage = async (storageDir: string, fileName: string) => {
  const match = OGP_FILE_NAME_PATTERN.exec(fileName);
  const contentType = match ? OGP_CONTENT_TYPES.get(match[1]) : undefined;
  if (!contentType) {
    return null;
  }

  try {
    const file = await readFile(join(storageDir, fileName));
    // Copy out of the pooled Buffer so the response body owns just these bytes.
    return { body: new Uint8Array(file), contentType };
  } catch {
    // A deleted or never-written file is a 404, not a server error.
    return null;
  }
};
