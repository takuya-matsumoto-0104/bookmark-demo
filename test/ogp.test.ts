import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractOgImageUrl } from "../src/server/ogp";
import { storeOgpImage } from "../src/server/storage";

const PAGE_URL = "https://example.com/post";
const IMAGE_URL = "https://cdn.example.com/cover.png";
const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PAGE_WITH_IMAGE = `<html><head><meta property="og:image" content="${IMAGE_URL}"></head></html>`;

const htmlResponse = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

describe("extractOgImageUrl", () => {
  it("extracts an absolute og:image URL", () => {
    expect(extractOgImageUrl(PAGE_WITH_IMAGE, PAGE_URL)).toBe(IMAGE_URL);
  });

  it("decodes one level of encoded ampersands in an og:image URL", () => {
    const html = `<meta property="og:image" content="${IMAGE_URL}?width=1200&amp;amp;height=630">`;

    expect(extractOgImageUrl(html, PAGE_URL)).toBe(`${IMAGE_URL}?width=1200&amp;height=630`);
  });

  it("resolves a relative og:image against the page URL", () => {
    const html = '<meta property="og:image" content="/images/cover.png">';

    expect(extractOgImageUrl(html, PAGE_URL)).toBe("https://example.com/images/cover.png");
  });

  it("returns null when the page has no og:image", () => {
    expect(extractOgImageUrl("<html><title>No image here</title></html>", PAGE_URL)).toBeNull();
  });

  it("rejects protocols other than http and https", () => {
    const html = '<meta property="og:image" content="data:image/png;base64,AAAA">';

    expect(extractOgImageUrl(html, PAGE_URL)).toBeNull();
  });
});

describe("storeOgpImage", () => {
  let storageDir: string;

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "bookmark-demo-ogp-"));
  });

  afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  it("saves the image and returns the path it is served from", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === PAGE_URL
        ? htmlResponse(PAGE_WITH_IMAGE)
        : new Response(IMAGE_BYTES, { headers: { "content-type": "image/png" } })
    );

    const stored = await storeOgpImage(PAGE_URL, storageDir, fetcher as typeof fetch);

    expect(stored).toMatch(/^\/ogp\/[0-9a-f-]{36}\.png$/);

    const files = await readdir(storageDir);
    expect(files).toHaveLength(1);
    expect(stored).toBe(`/ogp/${files[0]}`);
    expect(new Uint8Array(await readFile(join(storageDir, files[0])))).toEqual(IMAGE_BYTES);
  });

  it("returns an empty string when the page has no og:image", async () => {
    const fetcher = vi.fn(async () => htmlResponse("<html><title>No image here</title></html>"));

    await expect(storeOgpImage(PAGE_URL, storageDir, fetcher as typeof fetch)).resolves.toBe("");
    await expect(readdir(storageDir)).resolves.toEqual([]);
  });

  it("returns an empty string when the image content-type is not allowed", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === PAGE_URL
        ? htmlResponse(PAGE_WITH_IMAGE)
        : new Response("<html>Not an image</html>", { headers: { "content-type": "text/html" } })
    );

    await expect(storeOgpImage(PAGE_URL, storageDir, fetcher as typeof fetch)).resolves.toBe("");
    await expect(readdir(storageDir)).resolves.toEqual([]);
  });

  it("returns an empty string when the page cannot be fetched", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("network failed");
    });

    await expect(storeOgpImage(PAGE_URL, storageDir, fetcher as typeof fetch)).resolves.toBe("");
    await expect(readdir(storageDir)).resolves.toEqual([]);
  });
});
