// ================================================================
// epub.js — EPUB reader for the Pseudo-AI Browser
//
// How it works:
//   1. /epub  → opens a native file picker filtered to .epub
//   2. JSZip (loaded lazily from CDN) decompresses the file in-browser
//   3. container.xml  → locates the OPF package document
//   4. OPF manifest + spine → ordered list of chapter XHTML files
//   5. Each XHTML is converted to clean Markdown (headings, bold,
//      italic, paragraphs) and split into ~700-word chunks at
//      paragraph boundaries so every page feels like an LLM reply
//   6. Current position is bookmarked in localStorage so it
//      survives navigation (though the book must be re-opened
//      after a full page refresh)
//
// Navigation commands (all handled in browser.js dispatcher):
//   /epub       — open file picker
//   /next       — next page  (shared with feed pagination)
//   /prev       — previous page
//   /toc        — show table of contents
//   /chapter N  — jump to chapter N
//   /goto N     — jump to global page N
// ================================================================

// ── Config ───────────────────────────────────────────────────────
const EPUB_CHUNK_WORDS  = 700;   // target words per "page"
const EPUB_JSZIP_CDN    = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
const EPUB_BOOKMARK_KEY = 'pgb_epub_bookmark';

// ================================================================
//  PUBLIC API  (called from browser.js)
// ================================================================

/**
 * Open a file picker, parse the selected EPUB, and display
 * the first page in the current chat session.
 */
async function openEpub() {
    // Lazy-load JSZip the first time this is called
    await ensureJSZip();

    const file = await pickEpubFile();
    if (!file) return; // user cancelled

    const tid = showThinking();
    try {
        const arrayBuffer = await file.arrayBuffer();
        const zip         = await JSZip.loadAsync(arrayBuffer);

        // ── 1. Locate the OPF package document ───────────────────
        const containerXml = await readZipText(zip, 'META-INF/container.xml');
        const opfPath      = parseContainerXml(containerXml);

        // ── 2. Parse OPF: title, author, spine ───────────────────
        const opfXml             = await readZipText(zip, opfPath);
        const { title, author, spineItems } = parseOpf(opfXml, opfPath);

        // ── 3. Try to enrich chapter titles from NCX / NAV ────────
        const opfDir   = opfDirFromPath(opfPath);
        const titleMap = await buildTitleMap(zip, opfXml, opfDir);

        // ── 4. Extract & chunk each chapter ──────────────────────
        const chapters = [];
        for (const item of spineItems) {
            const fullPath = resolvePath(opfDir, item.href);
            const fileObj  = findZipEntry(zip, fullPath);
            if (!fileObj) continue;

            const html  = await fileObj.async('text');
            const mtext = epubHtmlToMarkdown(html);
            if (mtext.trim().length < 30) continue; // skip near-empty nav pages

            const chunks = chunkMarkdown(mtext, EPUB_CHUNK_WORDS);
            if (!chunks.length) continue;

            // Prefer title from NCX/NAV; fall back to h1 in the document
            const chTitle = titleMap[item.href]
                || extractH1(html)
                || `Chapter ${chapters.length + 1}`;

            chapters.push({ title: chTitle, chunks });
        }

        if (!chapters.length) throw new Error('No readable text found in this EPUB file.');

        // ── 5. Store in session ──────────────────────────────────
        const epubData = {
            title,
            author,
            chapters,
            chapterIdx: 0,
            chunkIdx:   0,
        };
        state.currentSession.epubData    = epubData;
        state.currentSession.lastCommand = { type: 'epub' };
        saveEpubBookmark(epubData);

        const totalPages = chapters.reduce((s, c) => s + c.chunks.length, 0);

        hideThinking(tid);

        // Show book header + first page
        const header =
            `## ${title}\n` +
            `*by ${author} • ${chapters.length} chapters • ${totalPages} pages*\n\n---\n\n`;
        await addBotMessageAnimated(header + renderEpubPage(epubData) + epubNav(epubData));
        updateEpubToolbar(); // show the nav bar

    } catch (err) {
        hideThinking(tid);
        addBotMessage(`**EPUB error:** ${escapeHtml(err.message)}\n\nMake sure the file is a valid .epub document.`);
    }
}

/** Advance one page forward. Returns false (with message) at end-of-book. */
async function epubPageNext() {
    const epub = state.currentSession.epubData;
    if (!epub) {
        await respondWith('No book open. Type `/epub` to open an EPUB file.', 250);
        return;
    }
    if (!advanceEpub(epub, +1)) {
        await addBotMessageAnimated(
            `**You have reached the end of *${epub.title}*.**\n\n` +
            `Type \`/prev\` to go back, \`/toc\` to browse chapters, or \`/epub\` to open another book.`
        );
        return;
    }
    saveEpubBookmark(epub);
    await addBotMessageAnimated(renderEpubPage(epub) + epubNav(epub));
    updateEpubToolbar();
}

/** Go back one page. Returns false (with message) at start-of-book. */
async function epubPagePrev() {
    const epub = state.currentSession.epubData;
    if (!epub) {
        await respondWith('No book open. Type `/epub` to open an EPUB file.', 250);
        return;
    }
    if (!advanceEpub(epub, -1)) {
        await addBotMessageAnimated(
            `**You are at the beginning of *${epub.title}*.**\n\n` +
            `Type \`/next\` to read forward or \`/toc\` for chapters.`
        );
        return;
    }
    saveEpubBookmark(epub);
    await addBotMessageAnimated(renderEpubPage(epub) + epubNav(epub));
    updateEpubToolbar();
}

/** Show the table of contents. */
async function epubShowToc() {
    const epub = state.currentSession.epubData;
    if (!epub) {
        await respondWith('No book open. Type `/epub` to open an EPUB file.', 250);
        return;
    }
    const totalPages = epub.chapters.reduce((s, c) => s + c.chunks.length, 0);
    let md = `## Table of Contents — *${epub.title}*\n\n`;
    let globalPage = 1;
    epub.chapters.forEach((ch, i) => {
        const active   = i === epub.chapterIdx;
        const marker   = active ? ' ← *here*' : '';
        const pages    = ch.chunks.length;
        md += `**${i + 1}.** ${active ? `**${ch.title}**` : ch.title}  `;
        md += `*(p.${globalPage}–${globalPage + pages - 1})*${marker}\n`;
        globalPage += pages;
    });
    md += `\n*${totalPages} total pages • \`/chapter N\` to jump • \`/goto N\` for a specific page*`;
    await respondWith(md, 200);
}

/** Jump to chapter N (1-based). */
async function epubJumpChapter(n) {
    const epub = state.currentSession.epubData;
    if (!epub) {
        await respondWith('No book open. Type `/epub` to open an EPUB file.', 250);
        return;
    }
    const idx = n - 1;
    if (idx < 0 || idx >= epub.chapters.length) {
        await addBotMessageAnimated(
            `Chapter ${n} doesn't exist — this book has ${epub.chapters.length} chapters.\n` +
            `Type \`/toc\` to see the full list.`
        );
        return;
    }
    epub.chapterIdx = idx;
    epub.chunkIdx   = 0;
    saveEpubBookmark(epub);
    await addBotMessageAnimated(renderEpubPage(epub) + epubNav(epub));
    updateEpubToolbar();
}

/** Jump to global page N (1-based). */
async function epubGotoPage(n) {
    const epub = state.currentSession.epubData;
    if (!epub) {
        await respondWith('No book open. Type `/epub` to open an EPUB file.', 250);
        return;
    }
    const total = epub.chapters.reduce((s, c) => s + c.chunks.length, 0);
    const target = n - 1; // convert to 0-based
    if (target < 0 || target >= total) {
        await addBotMessageAnimated(`Page ${n} is out of range — this book has ${total} pages.`);
        return;
    }
    // Walk through chapters to find the right chapter+chunk
    let remaining = target;
    for (let ci = 0; ci < epub.chapters.length; ci++) {
        const len = epub.chapters[ci].chunks.length;
        if (remaining < len) {
            epub.chapterIdx = ci;
            epub.chunkIdx   = remaining;
            break;
        }
        remaining -= len;
    }
    saveEpubBookmark(epub);
    await addBotMessageAnimated(renderEpubPage(epub) + epubNav(epub));
    updateEpubToolbar();
}

/** Show the last bookmarked page (useful after a reload). */
async function epubResume() {
    const bookmark = loadEpubBookmark();
    if (!bookmark) {
        await respondWith('No reading bookmark found. Type `/epub` to open a book.', 200);
        return;
    }
    const ago = formatTimeAgo(bookmark.savedAt);
    let md = `## Resume reading?\n\n`;
    md += `Last bookmark: ***${bookmark.title}*** by ${bookmark.author}\n`;
    md += `*Chapter ${bookmark.chapterIdx + 1}, page ${bookmark.globalPage} · saved ${ago}*\n\n---\n\n`;
    md += `${bookmark.lastChunk}\n\n---\n\n`;
    md += `*The book is no longer in memory — type \`/epub\` to re-open the file and continue from this point.*`;
    await respondWith(md, 300);
}

// ================================================================
//  NAVIGATION HELPERS
// ================================================================

/**
 * Move epub position by `delta` pages (+1 forward, -1 backward).
 * Returns false if already at the boundary.
 */
function advanceEpub(epub, delta) {
    if (delta > 0) {
        const ch = epub.chapters[epub.chapterIdx];
        if (epub.chunkIdx < ch.chunks.length - 1) {
            epub.chunkIdx++;
        } else if (epub.chapterIdx < epub.chapters.length - 1) {
            epub.chapterIdx++;
            epub.chunkIdx = 0;
        } else {
            return false; // end of book
        }
    } else {
        if (epub.chunkIdx > 0) {
            epub.chunkIdx--;
        } else if (epub.chapterIdx > 0) {
            epub.chapterIdx--;
            epub.chunkIdx = epub.chapters[epub.chapterIdx].chunks.length - 1;
        } else {
            return false; // start of book
        }
    }
    return true;
}

// ================================================================
//  RENDER
// ================================================================

/** Render the current page as a Markdown string. */
function renderEpubPage(epub) {
    const ch      = epub.chapters[epub.chapterIdx];
    const chunk   = ch.chunks[epub.chunkIdx];
    const global  = globalPageNum(epub);
    const total   = epub.chapters.reduce((s, c) => s + c.chunks.length, 0);

    let md = `### ${ch.title}\n`;
    md += `*Page ${global} of ${total} · Chapter ${epub.chapterIdx + 1} of ${epub.chapters.length}*\n\n`;
    md += chunk;
    return md;
}

/** Small navigation hint appended after each page. */
function epubNav(epub) {
    const global = globalPageNum(epub);
    const total  = epub.chapters.reduce((s, c) => s + c.chunks.length, 0);
    const atEnd  = global === total;
    const atStart = global === 1;

    let hints = '\n\n---\n*';
    if (!atStart) hints += '`/prev` ← ';
    hints += `page ${global}/${total}`;
    if (!atEnd)   hints += ' → `/next`';
    hints += ' · `/toc` · `/chapter N` · `/goto N`*';
    return hints;
}

function globalPageNum(epub) {
    let n = epub.chunkIdx + 1;
    for (let i = 0; i < epub.chapterIdx; i++) {
        n += epub.chapters[i].chunks.length;
    }
    return n;
}

// ================================================================
//  EPUB PARSING
// ================================================================

function parseContainerXml(xml) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const rf  = doc.querySelector('rootfile');
    if (!rf) throw new Error('Invalid EPUB: container.xml has no rootfile element.');
    return rf.getAttribute('full-path') || 'OEBPS/content.opf';
}

function parseOpf(xml, opfPath) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');

    // Title and author (handle both dc: prefixed and un-prefixed)
    const title  = (doc.querySelector('dc\\:title,  title')  || {}).textContent || 'Unknown Title';
    const author = (doc.querySelector('dc\\:creator, creator') || {}).textContent || 'Unknown Author';

    // Build id→href manifest
    const manifest = {};
    doc.querySelectorAll('manifest item').forEach(item => {
        const id   = item.getAttribute('id');
        const href = item.getAttribute('href');
        const type = item.getAttribute('media-type') || '';
        if (id && href) manifest[id] = { href, type };
    });

    // Spine = ordered reading list
    const spineItems = [];
    doc.querySelectorAll('spine itemref').forEach(ref => {
        const idref = ref.getAttribute('idref');
        const item  = manifest[idref];
        if (item && (item.type.includes('html') || item.type.includes('xml'))) {
            spineItems.push({ href: item.href });
        }
    });

    if (!spineItems.length) throw new Error('EPUB spine is empty — no readable chapters found.');
    return { title: title.trim(), author: author.trim(), spineItems };
}

/**
 * Try to build a map of { chapterHref → title } from the NCX or
 * NAV document embedded in the EPUB.  Falls back gracefully.
 */
async function buildTitleMap(zip, opfXml, opfDir) {
    const map = {};
    try {
        const doc = new DOMParser().parseFromString(opfXml, 'text/xml');

        // ── Try NCX (EPUB 2) ───────────────────────────────────
        const ncxItem = Array.from(doc.querySelectorAll('manifest item'))
            .find(i => i.getAttribute('media-type') === 'application/x-dtbncx+xml');
        if (ncxItem) {
            const ncxPath = resolvePath(opfDir, ncxItem.getAttribute('href'));
            const ncxFile = findZipEntry(zip, ncxPath);
            if (ncxFile) {
                const ncxXml = await ncxFile.async('text');
                const ndoc   = new DOMParser().parseFromString(ncxXml, 'text/xml');
                ndoc.querySelectorAll('navPoint').forEach(np => {
                    const src   = np.querySelector('content')?.getAttribute('src') || '';
                    const label = np.querySelector('navLabel text')?.textContent?.trim() || '';
                    if (src && label) map[src.split('#')[0]] = label;
                });
                return map;
            }
        }

        // ── Try NAV document (EPUB 3) ─────────────────────────
        const navItem = Array.from(doc.querySelectorAll('manifest item'))
            .find(i => i.getAttribute('properties')?.includes('nav'));
        if (navItem) {
            const navPath = resolvePath(opfDir, navItem.getAttribute('href'));
            const navFile = findZipEntry(zip, navPath);
            if (navFile) {
                const navHtml = await navFile.async('text');
                const hdoc    = new DOMParser().parseFromString(navHtml, 'text/html');
                hdoc.querySelectorAll('nav a').forEach(a => {
                    const href  = a.getAttribute('href')?.split('#')[0] || '';
                    const label = a.textContent.trim();
                    if (href && label) map[href] = label;
                });
            }
        }
    } catch (_) { /* title map is optional — fall through */ }
    return map;
}

// ================================================================
//  HTML → MARKDOWN CONVERSION
// ================================================================

/**
 * Convert EPUB chapter XHTML to clean Markdown.
 * Preserves headings, paragraphs, bold, italic, blockquotes.
 * Strips images, scripts, styles, nav elements, and bare links.
 */
function epubHtmlToMarkdown(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // Remove noise
    doc.querySelectorAll('script, style, nav, figure, figcaption, aside, img, svg').forEach(el => el.remove());

    function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent.replace(/\s+/g, ' ');
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return '';

        const tag      = node.tagName.toLowerCase();
        const children = Array.from(node.childNodes).map(walk).join('');

        switch (tag) {
            case 'h1':          return `\n# ${children.trim()}\n\n`;
            case 'h2':          return `\n## ${children.trim()}\n\n`;
            case 'h3':          return `\n### ${children.trim()}\n\n`;
            case 'h4': case 'h5': case 'h6':
                                return `\n**${children.trim()}**\n\n`;
            case 'p':           return `${children.trim()}\n\n`;
            case 'br':          return '\n';
            case 'hr':          return '\n---\n\n';
            case 'em': case 'i':
                                return children.trim() ? `*${children.trim()}*` : '';
            case 'strong': case 'b':
                                return children.trim() ? `**${children.trim()}**` : '';
            case 'blockquote':  return `\n> ${children.trim()}\n\n`;
            case 'li':          return `- ${children.trim()}\n`;
            case 'ul': case 'ol':
                                return `\n${children}\n`;
            case 'a':           return children; // strip links, keep text
            case 'sup': case 'sub':
                                return '';        // strip footnote markers
            default:            return children;
        }
    }

    return walk(doc.body)
        .replace(/[ \t]+/g, ' ')          // collapse horizontal whitespace
        .replace(/\n[ \t]+/g, '\n')       // trim leading spaces on lines
        .replace(/[ \t]+\n/g, '\n')       // trim trailing spaces
        .replace(/\n{3,}/g, '\n\n')       // max 2 consecutive blank lines
        .trim();
}

/**
 * Split Markdown text into ~`targetWords`-word chunks, always
 * breaking at paragraph boundaries (\n\n) rather than mid-sentence.
 */
function chunkMarkdown(text, targetWords = EPUB_CHUNK_WORDS) {
    const paragraphs = text.split(/\n\n+/);
    const chunks     = [];
    let current      = [];
    let wordCount    = 0;

    for (const para of paragraphs) {
        if (!para.trim()) continue;
        const wc = para.split(/\s+/).length;

        if (wordCount > 0 && wordCount + wc > targetWords * 1.15) {
            // Flush and start a new chunk
            chunks.push(current.join('\n\n'));
            current   = [para];
            wordCount = wc;
        } else {
            current.push(para);
            wordCount += wc;
        }
    }
    if (current.length) chunks.push(current.join('\n\n'));
    return chunks.filter(c => c.trim().length > 0);
}

/** Quick h1 scrape as a fallback chapter title. */
function extractH1(html) {
    const m = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
    if (!m) return null;
    return m[1].replace(/<[^>]+>/g, '').trim() || null;
}

// ================================================================
//  ZIP HELPERS
// ================================================================

function opfDirFromPath(opfPath) {
    return opfPath.includes('/') ? opfPath.split('/').slice(0, -1).join('/') + '/' : '';
}

function resolvePath(baseDir, href) {
    if (!href) return '';
    const decoded = href.includes('%') ? decodeURIComponent(href) : href;
    if (decoded.startsWith('/')) return decoded.slice(1);
    // Handle ../ relative paths
    const segments = (baseDir + decoded).split('/');
    const resolved = [];
    for (const seg of segments) {
        if (seg === '..')   resolved.pop();
        else if (seg !== '.') resolved.push(seg);
    }
    return resolved.join('/');
}

function findZipEntry(zip, path) {
    // 1. Exact match
    let entry = zip.file(path);
    if (entry) return entry;

    // 2. Decoded match
    try { entry = zip.file(decodeURIComponent(path)); if (entry) return entry; } catch (_) {}

    // 3. Case-insensitive fallback
    const lower = path.toLowerCase();
    const match = Object.keys(zip.files).find(k => k.toLowerCase() === lower);
    return match ? zip.file(match) : null;
}

async function readZipText(zip, path) {
    const entry = findZipEntry(zip, path);
    if (!entry) throw new Error(`EPUB is missing required file: ${path}`);
    return await entry.async('text');
}

// ================================================================
//  FILE PICKER
// ================================================================

function pickEpubFile() {
    return new Promise(resolve => {
        const input   = document.createElement('input');
        input.type    = 'file';
        input.accept  = '.epub,application/epub+zip';

        // Resolve immediately if the dialog is cancelled
        const onFocus = () => {
            window.removeEventListener('focus', onFocus);
            setTimeout(() => { if (!input.files?.length) resolve(null); }, 400);
        };
        window.addEventListener('focus', onFocus);

        input.onchange = () => {
            window.removeEventListener('focus', onFocus);
            resolve(input.files[0] || null);
        };
        input.click();
    });
}

// ================================================================
//  JSZIP LOADER
// ================================================================

let _jszipLoading = null;

function ensureJSZip() {
    if (typeof JSZip !== 'undefined') return Promise.resolve();
    if (_jszipLoading) return _jszipLoading;

    _jszipLoading = new Promise((resolve, reject) => {
        const s   = document.createElement('script');
        s.src     = EPUB_JSZIP_CDN;
        s.onload  = resolve;
        s.onerror = () => reject(new Error('Could not load JSZip — check your internet connection.'));
        document.head.appendChild(s);
    });
    return _jszipLoading;
}

// ================================================================
//  BOOKMARK  (localStorage)
// ================================================================

function saveEpubBookmark(epub) {
    try {
        const global = globalPageNum(epub);
        const bookmark = {
            title:      epub.title,
            author:     epub.author,
            chapterIdx: epub.chapterIdx,
            chunkIdx:   epub.chunkIdx,
            globalPage: global,
            totalPages: epub.chapters.reduce((s, c) => s + c.chunks.length, 0),
            // Store the last chunk text so it can be previewed without the file
            lastChunk:  epub.chapters[epub.chapterIdx]?.chunks[epub.chunkIdx] || '',
            savedAt:    Date.now(),
        };
        localStorage.setItem(EPUB_BOOKMARK_KEY, JSON.stringify(bookmark));
    } catch (_) { /* non-critical */ }
}

function loadEpubBookmark() {
    try {
        const raw = localStorage.getItem(EPUB_BOOKMARK_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
}

function formatTimeAgo(ts) {
    const secs = Math.floor((Date.now() - ts) / 1000);
    if (secs < 60)   return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400)return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
}
