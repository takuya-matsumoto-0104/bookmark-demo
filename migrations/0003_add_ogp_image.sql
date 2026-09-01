-- SQLite backfills existing rows with this DEFAULT, so a NOT NULL column can be
-- added to an already populated table without a separate UPDATE step.
-- Empty string is the "no og:image known" marker: rows saved before this feature
-- existed, plus seed data, never had one fetched, and pages that simply lack an
-- og:image tag stay empty too. Keeping '' instead of NULL means callers can rely
-- on the value always being a string and test it with a plain emptiness check.
ALTER TABLE bookmarks ADD COLUMN ogp_image_url TEXT NOT NULL DEFAULT '';
