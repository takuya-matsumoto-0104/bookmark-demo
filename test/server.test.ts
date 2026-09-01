import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import { BookmarkDatabase } from "../src/server/db";

let tempDir: string;
let db: BookmarkDatabase;

const createTestApp = () => createApp({ db, ogpDir: join(tempDir, "ogp") });

const addBookmark = (input: {
  url: string;
  title: string;
  tags?: string;
  memo?: string;
  ogpImageUrl?: string;
}) =>
  db.createBookmark({
    url: input.url,
    title: input.title,
    tags: input.tags ?? "",
    memo: input.memo ?? "",
    ogpImageUrl: input.ogpImageUrl ?? ""
  });

const OGP_PAGE_URL = "https://example.com/post";
const OGP_IMAGE_URL = "https://cdn.example.com/cover.png";
const OGP_IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// app.ts always calls the global fetch, so the page and the image are both served
// from here instead of through an injected fetcher.
const stubOgpFetch = () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === OGP_PAGE_URL) {
      return new Response(`<title>Post</title><meta property="og:image" content="${OGP_IMAGE_URL}">`, {
        headers: { "content-type": "text/html" }
      });
    }
    if (url === OGP_IMAGE_URL) {
      return new Response(OGP_IMAGE_BYTES, { headers: { "content-type": "image/png" } });
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  });

  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};

const createOgpBookmark = async (app: ReturnType<typeof createTestApp>) => {
  const response = await app.request("http://localhost/api/bookmarks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: OGP_PAGE_URL })
  });

  return {
    response,
    body: (await response.json()) as { bookmark: { id: number; ogpImageUrl: string } }
  };
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "bookmark-demo-"));
  db = new BookmarkDatabase(join(tempDir, "bookmarks.sqlite"));
  db.migrate(join(process.cwd(), "migrations"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("local server bookmarks API", () => {
  it("returns 404 for the removed OGP image endpoint", async () => {
    const response = await createTestApp().request("http://localhost/api/ogp/some-name");

    expect(response.status).toBe(404);
  });

  it("clamps an out-of-range page before selecting bookmarks", async () => {
    for (let index = 1; index <= 21; index += 1) {
      addBookmark({
        url: `https://example.com/${index}`,
        title: `Example ${index}`
      });
    }

    const response = await createTestApp().request("http://localhost/api/bookmarks?page=99");
    const body = await response.json() as {
      bookmarks: Array<{ id: number }>;
      page: number;
      pageSize: number;
      totalCount: number;
      totalPages: number;
    };

    expect(response.status).toBe(200);
    expect(body.page).toBe(3);
    expect(body.pageSize).toBe(10);
    expect(body.totalCount).toBe(21);
    expect(body.totalPages).toBe(3);
    expect(body.bookmarks).toHaveLength(1);
  });

  it("uses AND search terms across bookmark fields", async () => {
    addBookmark({
      url: "https://example.com/hono",
      title: "Hono",
      tags: "typescript, database",
      memo: "Framework"
    });
    addBookmark({
      url: "https://example.com/sqlite",
      title: "SQLite",
      tags: "database",
      memo: "Local data"
    });
    addBookmark({
      url: "https://example.com/react",
      title: "React",
      tags: "ui",
      memo: "Client"
    });

    const response = await createTestApp().request("http://localhost/api/bookmarks?q=hono%20database");
    const body = await response.json() as { bookmarks: Array<{ title: string }>; totalCount: number };

    expect(response.status).toBe(200);
    expect(body.totalCount).toBe(1);
    expect(body.bookmarks.map((bookmark) => bookmark.title)).toEqual(["Hono"]);
  });

  it("creates a bookmark and rejects duplicate normalized URLs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<title>Example</title>", { headers: { "content-type": "text/html" } }))
    );

    const app = createTestApp();
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/#top" })
    };
    const created = await app.request("http://localhost/api/bookmarks", request);
    const duplicate = await app.request("http://localhost/api/bookmarks", request);

    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      bookmark: {
        url: "https://example.com/",
        title: "Example"
      }
    });
    expect(duplicate.status).toBe(409);
  });

  it("updates and deletes a bookmark", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<title>Updated</title>", { headers: { "content-type": "text/html" } }))
    );
    const bookmark = addBookmark({
      url: "https://example.com/old",
      title: "Old"
    });
    const app = createTestApp();

    const updated = await app.request(`http://localhost/api/bookmarks/${bookmark.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/new",
        tags: " local, sqlite ",
        memo: " updated "
      })
    });
    const deleted = await app.request(`http://localhost/api/bookmarks/${bookmark.id}`, {
      method: "DELETE"
    });
    const missing = await app.request(`http://localhost/api/bookmarks/${bookmark.id}`, {
      method: "DELETE"
    });

    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      bookmark: {
        url: "https://example.com/new",
        title: "Updated",
        tags: "local, sqlite",
        memo: "updated"
      }
    });
    expect(deleted.status).toBe(204);
    expect(missing.status).toBe(404);
  });

  it("stores the OGP image while creating a bookmark", async () => {
    const fetcher = stubOgpFetch();

    const { response, body } = await createOgpBookmark(createTestApp());

    expect(response.status).toBe(201);
    expect(body.bookmark.ogpImageUrl).toMatch(/^\/ogp\/[0-9a-f-]{36}\.png$/);
    expect(fetcher.mock.calls.map(([input]) => String(input))).toContain(OGP_IMAGE_URL);
    await expect(readdir(join(tempDir, "ogp"))).resolves.toHaveLength(1);
  });

  it("removes a newly stored OGP image when bookmark creation fails", async () => {
    stubOgpFetch();
    vi.spyOn(db, "createBookmark").mockImplementationOnce(() => {
      throw new Error("database write failed");
    });

    const { response } = await createOgpBookmark(createTestApp());

    expect(response.status).toBe(500);
    await expect(readdir(join(tempDir, "ogp"))).resolves.toEqual([]);
  });

  it("replaces and removes stored OGP images with their bookmarks", async () => {
    stubOgpFetch();
    const app = createTestApp();
    const { body: createdBody } = await createOgpBookmark(app);

    const updated = await app.request(`http://localhost/api/bookmarks/${createdBody.bookmark.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: OGP_PAGE_URL })
    });
    const updatedBody = (await updated.json()) as { bookmark: { ogpImageUrl: string } };

    expect(updated.status).toBe(200);
    expect(updatedBody.bookmark.ogpImageUrl).not.toBe(createdBody.bookmark.ogpImageUrl);
    await expect(readdir(join(tempDir, "ogp"))).resolves.toEqual([
      updatedBody.bookmark.ogpImageUrl.split("/").at(-1)
    ]);

    const deleted = await app.request(`http://localhost/api/bookmarks/${createdBody.bookmark.id}`, {
      method: "DELETE"
    });

    expect(deleted.status).toBe(204);
    await expect(readdir(join(tempDir, "ogp"))).resolves.toEqual([]);
  });

  it("keeps the previous OGP image when a bookmark update fails", async () => {
    stubOgpFetch();
    const app = createTestApp();
    const { body: createdBody } = await createOgpBookmark(app);
    vi.spyOn(db, "updateBookmark").mockImplementationOnce(() => {
      throw new Error("database write failed");
    });

    const updated = await app.request(`http://localhost/api/bookmarks/${createdBody.bookmark.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: OGP_PAGE_URL })
    });

    expect(updated.status).toBe(500);
    await expect(readdir(join(tempDir, "ogp"))).resolves.toEqual([
      createdBody.bookmark.ogpImageUrl.split("/").at(-1)
    ]);
  });

  it("serves a stored OGP image", async () => {
    stubOgpFetch();
    const app = createTestApp();
    const { body } = await createOgpBookmark(app);

    const image = await app.request(`http://localhost${body.bookmark.ogpImageUrl}`);

    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toBe("public, max-age=86400, immutable");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(OGP_IMAGE_BYTES);
  });

  it("returns 404 for an OGP image that was never stored", async () => {
    const response = await createTestApp().request(
      "http://localhost/ogp/00000000-0000-0000-0000-000000000000.png"
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Image not found." });
  });
});
