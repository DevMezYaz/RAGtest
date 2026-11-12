import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DB_PATH } from "./config.js";

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  folder TEXT NOT NULL,
  kind TEXT NOT NULL,          -- pdf | doc | slides | sheet | text | image | other
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  pages INTEGER NOT NULL DEFAULT 0,
  keywords TEXT NOT NULL DEFAULT '',
  has_text INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pages_file ON pages(file_id, page);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  text, content='pages', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  name, folder, keywords, content='files', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
  INSERT INTO files_fts(rowid, name, folder, keywords) VALUES (new.id, new.name, new.folder, new.keywords);
END;
CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, name, folder, keywords) VALUES ('delete', old.id, old.name, old.folder, old.keywords);
  INSERT INTO files_fts(rowid, name, folder, keywords) VALUES (new.id, new.name, new.folder, new.keywords);
END;
CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, name, folder, keywords) VALUES ('delete', old.id, old.name, old.folder, old.keywords);
END;
`);
db.pragma("foreign_keys = ON");
// text found in images (see ocr.ts): 0 = not read yet, 1 = read (with or without any text found)
// 1 = the AI description / summary has been made (level 5)
try { db.exec("ALTER TABLE files ADD COLUMN smart INTEGER NOT NULL DEFAULT 0"); } catch { /* already there */ }
try { db.exec("ALTER TABLE files ADD COLUMN ocr INTEGER NOT NULL DEFAULT 0"); } catch { /* already there */ }

export interface FileRow {
  id: number; path: string; name: string; ext: string; folder: string; kind: string;
  size: number; mtime: number; pages: number; keywords: string; has_text: number; error: string | null;
}
