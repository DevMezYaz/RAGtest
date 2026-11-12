# Yab

**Your files, in a drawer that answers back.**

Yab is a local-first desktop assistant for the files on your computer. You point it at your folders and ask questions in plain language. It finds the right file, reads the right pages, and answers with the exact page cited. Everything is indexed on your own machine, and you decide which folders it can see.

It lives on your desktop as a small floating icon. Click it and it unfolds into a filing drawer holding all your documents.

Current version: **1.3.1** · Platforms: **macOS 13+** and **Windows** · Built with Electron, Hono, React and SQLite.

---

## What is this, in plain words?

Most of us have thousands of files (bills, contracts, scans, spreadsheets, photos) and no good way to find the one we need. File names don't help when the file is called `scan_0042.pdf`.

Yab reads what is *inside* your files and builds a private search index on your computer. When you ask "what was my electricity bill in March?", it searches that index, pulls the few relevant pages, and answers with a link to the page it used. Click the citation and the file opens at that page with the answer highlighted.

This is a **RAG (retrieval-augmented generation)** app. Retrieval runs locally; an AI model is only used, optionally, to read the handful of snippets it retrieves and write the answer.

## What can I use it for?

- **Finding a document you half remember.** "The contract with the Pune vendor", "invoices from last year", "spreadsheets about budget".
- **Getting an answer, not just a file.** "What was the total on the March invoice?", "Summarise last year's budget sheet."
- **Searching scans and photos.** Screenshots, photographed receipts and bank statements are readable through your computer's built-in text recognition.
- **Searching by meaning.** "Photo of the sea" can find a beach picture; "tax return" can find a page about income declaration.
- **Doing small chores, with your approval.** Edit a document or sheet, move a file, draft an email. Yab proposes each one as a card and nothing happens until you click approve.
- **Working fully offline.** Offline mode uses no AI and sends nothing anywhere, and still searches by content, name and meaning.
- **Building on it.** There is a local HTTP API (see below) if you want to wire the index into your own tools.

## How it works

```
 your folders ──► scanner ──► text extraction (PDF, Word, Excel/CSV, text, OCR for images)
                                   │
                                   ▼
                    SQLite index in data/  (full-text + file names + local meaning vectors)
                                   │
        your question ──► hybrid search ──► top snippets/pages ──► (optional) AI model ──► cited answer
```

1. **Scan.** Only the folders you tick under *Access* are read. The index updates in the background as files change.
2. **Index.** Text is extracted and stored in SQLite (FTS5). Keywords and "meaning" vectors are computed locally with a small bundled model.
3. **Search.** Your question is matched with a blend of word search, typo-tolerant file-name search, meaning search and date / file-type filters.
4. **Answer.** In Online mode, an AI model gets only what its tool calls return (snippets, pages, or an image it explicitly asks for), limited by the AI level you chose. In Offline mode no AI is involved at all.

---

## What's new in 1.3.1

1.3.1 reworks keyboard shortcuts so opening and closing Yab is one predictable key, and every shortcut is rebindable.

- **One key to open and close.** The separate *Open Yab*, *Fold into widget* and *Close to widget* actions are merged into a single **Open / close Yab** action. The default is **Cmd+W** on Mac and **Ctrl+W** on Windows.
- **Bring Yab to front from any app.** **Option+Shift+Space** (Mac) / **Alt+Shift+Space** (Windows) raises Yab even when it is buried under other windows, and opens it if it was closed. This is the only shortcut that is global by default.
- **Optional global open / close.** Cmd/Ctrl+W is never grabbed globally (that would break closing tabs in every other app). If you bind *Open / close Yab* to any other combination, it works from every app.
- **Conflict feedback.** If another app already owns a combination you pick, Yab tells you and keeps your previous binding instead of silently failing.
- **Cleaner defaults.** *Flip widget* and *Switch effect* no longer ship with default keys (you can still assign them), freeing combinations that clashed with other apps.
- **Reload.** Cmd/Ctrl+R always does a clean reload that bypasses the cache.
- **Smoother fold.** Pressing Cmd/Ctrl+W as the fold is already being prepared now completes that fold instead of being ignored, and the menu no longer lists a key twice when it is global.

### Version history

| Version | Highlights |
|---|---|
| **1.3.1** | Shortcut rework described above. |
| **1.3** | Bundled search-by-meaning model ([potion-base-8M](https://huggingface.co/minishlab/potion-base-8M)); UI and server updates. |
| **1.2 / 1.1 / 1.0** | Earlier builds. Their packaged apps are attached to the GitHub Releases for reference. |

Each release on the [Releases page](../../releases) includes a Mac and a Windows build.

---

## Features

### Ask your files anything
- **Plain-language questions** with answers that cite files and pages. Click a citation to open the file at that page with the answer highlighted.
- **Understands dates and types:** "invoices from last year", "spreadsheets about budget".
- **Reads what's inside the file**, not just its name: PDFs, Word documents, Excel and CSV sheets, text files and images.
- **Built-in viewer:** PDFs, images and documents open inside Yab; a button opens the file in its normal app.
- **Proposes actions, never does them silently:** edit a document or sheet, move a file, draft an email. Each one appears as a card and nothing happens until you approve it.

### Search by meaning
- Runs from a small bundled model ([minishlab/potion-base-8M](https://huggingface.co/minishlab/potion-base-8M), MIT licence, about 30 MB). No internet, no AI service, milliseconds per query.
- Blended with ordinary word search, file-name search (typo tolerant) and date / file-type filters.

### Reads text inside images
- Scans, photos of documents, screenshots and bank statements become searchable using your computer's own text recognition: Apple Vision on Mac, Windows OCR on Windows. Images never leave your machine.
- On Mac, Yab also labels what's in a photo ("dog on a beach").
- On Windows, image text search needs an OCR language pack installed in Windows.

### Online or Offline
- **Online** (the default) uses an AI model to read and reason over your files. Use an [OpenRouter](https://openrouter.ai) key (cheapest, defaults to Claude Haiku) or an Anthropic (Claude) key, set in the model settings. Saving a Claude key makes it the active one; the other key stays saved but unused. There is no automatic fallback: if the active key fails you see the error.
- **Offline** uses no AI at all and sends nothing anywhere.

### Five AI levels
Set in the widget menu, depending on how much the AI may read.

| Level | What the AI reads |
|---|---|
| 1 Private | short snippets only |
| 2 Balanced (default) | a few pages when needed |
| 3 Informed | more pages; can look at an image when asked |
| 4 Deep | whole documents and several images |
| 5 Full smart index | a one-time pass where AI describes every image and summarises every document, so later searches are sharper. Shows a cost estimate and asks first for big scans; can use its own key and model. |

### You control what it can see
- Choose folders in **Access** and change them any time. Removing a folder purges its files from the index at once.
- Paths matching `sensitivePatterns` (for example "password", "wallet", `.env`) are never indexed, never served and never sent to an AI.
- The index lives in `data/` on your computer and updates in the background as files change.

### Look and feel
- **File drawer:** colour-coded folders from a large palette; a **dimensional** style where only the hovered folder lifts in 3D; several file-opening styles; optional soft shadows.
- **Infinite drawer:** scroll the whole collection as one endless stack. Order by random, A-Z, newest, oldest, folder, kind or size. Five scroll-feel presets. **Auto-scroll** drifts the home screen on its own and stops when you touch it.
- **Widget:** drag it anywhere, resize from Tiny to Extra large, flip it, hide it. It floats above other windows while the main window behaves normally: click another app and Yab steps back.
- **Open / close effect:** the widget folds out into the window and back, with physics presets, or a plain fade. A performance setting helps older machines.

### Widget menu
Right-click the widget (or use the Dock / tray menu): Open / close Yab, Hide widget, Performance, Shadows, File opening, Folder style, Infinite drawer, Scroll feel, Auto scroll, AI mode, AI access, Read text in images, Open/close effect, Launch physics, Flip, Resize widget, Shortcuts, **Quit settings**, Quit Yab.

The menu reappears after each pick so you can change several settings in a row. Choices apply together when you choose **Quit settings** or click away.

### Shortcuts (all rebindable under Shortcuts in the widget menu)

| Action | Mac | Windows |
|---|---|---|
| Open / close Yab | Cmd+W | Ctrl+W |
| Bring Yab to front (any app; opens Yab if closed) | Option+Shift+Space | Alt+Shift+Space |
| Maximise / restore | Cmd+Shift+M | Ctrl+Shift+M |
| Show / hide widget | Cmd+Shift+H | Ctrl+Shift+H |
| Reload | Cmd+R | Ctrl+R |

Flip widget and Switch effect have no default key but can be assigned. Give Open / close Yab a combination other than Cmd/Ctrl+W and it also works from every app.

---

## Install (release builds)

Download the zip for your system from the [Releases page](../../releases).

- **Mac:** unzip, drag **Yab.app** to Applications. If macOS blocks it the first time, right-click it and choose **Open**.
- **Windows:** unzip, run **Yab.exe**. If SmartScreen warns you, choose **More info**, then **Run anyway**.

On first launch choose the folders Yab may read. It indexes in the background, so you can search straight away. Only one copy of Yab runs at a time.

**API key:** the release builds ship with a placeholder key, so Online mode will not work until you add your own in the model settings (or you can simply use Offline mode, which needs no key).

## Run from source

Requirements: a recent Node.js and npm.

```
npm install
node scripts/get-models.mjs        # downloads the search-by-meaning model into models/
cp .env.example .env               # then put your own OpenRouter or Anthropic key in .env (or run Offline without one)
npm run scan                       # first scan of the folders in sleepy.config.json
npm run app                        # builds the UI and opens the floating widget
```

`.env.example` contains only dummy values (`sk-or-...`). Your real `.env` is git-ignored, so keys never get committed.

Other commands:
- `npm run dev` runs the UI on http://localhost:5173 with the API on :4477
- `npm run build:web && npm start` runs a single server on :4477
- `npm run search -- "words"` does a local search with no AI
- `npm run ask -- "question"` asks from the terminal
- `npm run ocr` reads text from images
- `npm run typecheck` type-checks the server and web code

If you launch from VS Code's terminal and Electron acts like plain Node, that's `ELECTRON_RUN_AS_NODE`; `npm run app` already unsets it.

### Configuration
Settings live in `sleepy.config.json`: the folders to index, excluded folders, `sensitivePatterns`, file-size limits, provider and model, AI level and mode, OCR on/off and scan interval. Most of these are also editable from inside the app.

## Build the apps
```
bash scripts/pack-mac.sh     # dist-mac/Yab.app and Yab-mac.zip
bash scripts/pack-win.sh     # dist-win/Yab and Yab-win.zip (can be built on a Mac)
```
Both copy the Electron files, the server, the built web UI and `models/`. **Keep your own `.env` out of any build you share**: the packagers copy it into the app, so delete it or replace it with `.env.example` before zipping a build for others.

## Privacy
- Everything indexed stays in `data/` on your machine; keywords and meaning vectors are computed locally.
- Online mode only sends what the AI's tool calls return: search snippets and pages or images it explicitly reads, within the level you chose.
- Offline mode sends nothing.
- The API binds to 127.0.0.1. Set `SLEEPY_API_KEY` (and `allowedOrigins`) before exposing it elsewhere.

## API (all under /v1)

| | |
|---|---|
| `POST /chat` `{message, conversationId}` | SSE: `status`, `hits`, `final {mode, message, files:[{file,page,quote}]}` |
| `POST /search` `{query, mode: "content"\|"names", kind?, folder?}` | raw ranked results, no AI |
| `GET /files/:id`, `/files/:id/pages?from&to`, `/files/:id/raw` | metadata, extracted text, original bytes (pdf/images) |
| `GET /drawer` | the infinite-drawer file list in the chosen order |
| `GET/PUT /ai`, `/ai/smart`, `/ai/estimate`, `/ocr` | AI mode and level, smart index, cost estimate, image text |
| `POST /index/scan`, `GET /index/status`, `GET/PUT /config` | indexing and settings |

## Project layout
- `electron/`: the widget, the main window, the open/close effect and shortcuts
- `server/`: the API, scanner, SQLite FTS5 index, OCR, search by meaning, offline search and the AI agent
- `web/`: the React UI (drawer, viewer, access and model settings)
- `scripts/`: model download and the Mac / Windows packagers
- `build/`: app icons and animation assets
- `web/mosby/`: a standalone recreation of the mosbyfiles.com landing transition, kept as a motion reference
