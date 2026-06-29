// ================================================================
// PSEUDO-AI BROWSER — browser.js
//
// Core engine:
//   • Slash commands for Reddit and 20 confirmed-working RSS feeds
//   • All RSS fetched via rss2json.com (handles CORS for every source)
//   • Reddit fetched directly (supports CORS natively)
//   • Inline Markdown renderer — zero external libraries
//   • Session history backed by localStorage
//   • Typing animation that mimics LLM streaming
// ================================================================

// ── RSS-to-JSON API (tested — handles CORS for all feeds below) ──
const RSS2JSON = 'https://api.rss2json.com/v1/api.json?rss_url=';

// ── CORS proxies for Reddit fallback ────────────────────────────
const PROXIES = [
    'https://api.allorigins.win/raw?url=',
    'https://corsproxy.io/?',
];

// ================================================================
//  FEED REGISTRY
//  Every entry here has a confirmed-working slash command.
//  Key      = the command name  (user types /<key>)
//  cat      = category for /news, /tech, /science, /finance, /culture
//  url      = the RSS/Atom feed URL passed to rss2json
// ================================================================
const FEEDS = {

    // ── General News ─────────────────────────────────────────────
    bbc:          { name: 'BBC News',           cat: 'news',    url: 'https://feeds.bbci.co.uk/news/rss.xml' },
    guardian:     { name: 'The Guardian',       cat: 'news',    url: 'https://www.theguardian.com/world/rss' },
    npr:          { name: 'NPR News',           cat: 'news',    url: 'https://feeds.npr.org/1001/rss.xml' },
    nyt:          { name: 'New York Times',     cat: 'news',    url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml' },
    aj:           { name: 'Al Jazeera',         cat: 'news',    url: 'https://www.aljazeera.com/xml/rss/all.xml' },

    // ── Tech & Programming ────────────────────────────────────────
    hn:           { name: 'Hacker News',        cat: 'tech',    url: 'https://hnrss.org/frontpage' },
    ars:          { name: 'Ars Technica',       cat: 'tech',    url: 'https://feeds.arstechnica.com/arstechnica/index' },
    tc:           { name: 'TechCrunch',         cat: 'tech',    url: 'https://techcrunch.com/feed/' },
    verge:        { name: 'The Verge',          cat: 'tech',    url: 'https://www.theverge.com/rss/index.xml' },
    wired:        { name: 'Wired',              cat: 'tech',    url: 'https://www.wired.com/feed/rss' },
    slashdot:     { name: 'Slashdot',           cat: 'tech',    url: 'http://rss.slashdot.org/Slashdot/slashdotMain' },
    lobsters:     { name: 'Lobste.rs',          cat: 'tech',    url: 'https://lobste.rs/rss' },
    mit:          { name: 'MIT Tech Review',    cat: 'tech',    url: 'https://www.technologyreview.com/feed/' },

    // ── Science ───────────────────────────────────────────────────
    nasa:         { name: 'NASA',               cat: 'science', url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss' },
    quanta:       { name: 'Quanta Magazine',    cat: 'science', url: 'https://www.quantamagazine.org/feed/' },
    sciencedaily: { name: 'Science Daily',      cat: 'science', url: 'https://www.sciencedaily.com/rss/all.xml' },
    phys:         { name: 'Phys.org',           cat: 'science', url: 'https://phys.org/rss-feed/' },

    // ── Finance ───────────────────────────────────────────────────
    marketwatch:  { name: 'MarketWatch',        cat: 'finance', url: 'https://feeds.marketwatch.com/marketwatch/topstories/' },

    // ── Long-form & Culture ───────────────────────────────────────
    longreads:    { name: 'Longreads',          cat: 'culture', url: 'https://longreads.com/feed/' },
    atlantic:     { name: 'The Atlantic',       cat: 'culture', url: 'https://www.theatlantic.com/feed/all/' },
};

// Category names → human-readable labels
const CAT_LABELS = {
    news:    'World News',
    tech:    'Tech & Programming',
    science: 'Science',
    finance: 'Finance',
    culture: 'Long-form & Culture',
};

// ── Random subreddits for /random ────────────────────────────────
const RANDOM_SUBS = [
    'worldnews', 'technology', 'science', 'programming', 'todayilearned',
    'explainlikeimfive', 'askscience', 'dataisbeautiful', 'futurology',
    'space', 'history', 'philosophy', 'economics', 'geopolitics',
    'netsec', 'singularity', 'artificial', 'MachineLearning', 'news',
];

// ── Global app state ─────────────────────────────────────────────
const state = {
    sessions:       [],
    currentSession: null,
};

// ================================================================
//  SESSION MANAGEMENT
// ================================================================

function initApp() {
    loadSessions();
    if (state.sessions.length === 0) {
        createNewSession();
    } else {
        switchSession(state.sessions[0].id);
    }
    renderSidebar();
}

function createNewSession() {
    const session = {
        id:          Date.now().toString(),
        title:       'New Chat',
        messages:    [],
        lastCommand: null,
        lastData:    null,
        page:        0,
        created:     Date.now(),
    };
    state.sessions.unshift(session);
    state.currentSession = session;
    saveSessions();
    renderSidebar();
    renderMessages();
    updateEpubToolbar();
}

function switchSession(id) {
    const found = state.sessions.find(s => s.id === id);
    if (!found) return;
    state.currentSession = found;
    renderMessages();
    renderSidebar();
    updateEpubToolbar();
}

function saveSessions() {
    try {
        const toSave = state.sessions.slice(0, 30).map(s => ({
            ...s,
            messages: s.messages.slice(-50),
            lastData: null,
            epubData: null, // never persist raw chapter text — too large for localStorage
        }));
        localStorage.setItem('pgb_sessions', JSON.stringify(toSave));
    } catch (_) {
        try { localStorage.removeItem('pgb_sessions'); } catch (_) {}
    }
}

function loadSessions() {
    try {
        const raw = localStorage.getItem('pgb_sessions');
        if (raw) state.sessions = JSON.parse(raw);
    } catch (_) {
        state.sessions = [];
    }
}

// ================================================================
//  COMMAND DISPATCHER
// ================================================================

async function handleInput(raw) {
    const input = raw.trim();
    if (!input) return;

    addUserMessage(input);

    const lower = input.toLowerCase();

    // ── /clear ────────────────────────────────────────────────────
    if (lower === '/clear') {
        state.currentSession.messages = [];
        state.currentSession.lastData    = null;
        state.currentSession.lastCommand = null;
        saveSessions();
        renderMessages();
        return;
    }

    // ── /help ─────────────────────────────────────────────────────
    if (lower === '/help') {
        await respondWith(getHelpText(), 250);
        return;
    }

    // ── /sources — list all available feeds ───────────────────────
    if (lower === '/sources') {
        await respondWith(getSourcesList(), 250);
        return;
    }

    // ── EPUB commands ─────────────────────────────────────────────

    if (lower === '/epub') {
        await openEpub(); // defined in epub.js
        return;
    }

    if (lower === '/prev') {
        await epubPagePrev(); // defined in epub.js
        return;
    }

    if (lower === '/toc') {
        await epubShowToc(); // defined in epub.js
        return;
    }

    if (lower === '/bookmark') {
        await epubResume(); // show last saved position
        return;
    }

    // /chapter N — jump to chapter
    const chapterMatch = lower.match(/^\/chapter\s+(\d+)$/);
    if (chapterMatch) {
        await epubJumpChapter(parseInt(chapterMatch[1], 10));
        return;
    }

    // /goto N — jump to global page number
    const gotoMatch = lower.match(/^\/goto\s+(\d+)$/);
    if (gotoMatch) {
        await epubGotoPage(parseInt(gotoMatch[1], 10));
        return;
    }

    // ── /next — epub page OR feed pagination ──────────────────────
    if (lower === '/next') {
        // If a book is currently loaded in this session, advance the book
        if (state.currentSession.epubData) {
            await epubPageNext(); // defined in epub.js
            return;
        }
        // Otherwise fall through to feed pagination
        if (!state.currentSession.lastCommand) {
            await respondWith('No active feed to page. Try `/news`, `/tech`, `/bbc`, or `/reddit`.', 300);
            return;
        }
        state.currentSession.page++;
        await executeCommand(state.currentSession.lastCommand);
        return;
    }

    // ── /random — surprise subreddit ──────────────────────────────
    if (lower === '/random') {
        const sub = RANDOM_SUBS[Math.floor(Math.random() * RANDOM_SUBS.length)];
        const cmd = { type: 'reddit', sub, sort: 'hot' };
        state.currentSession.lastCommand = cmd;
        state.currentSession.page = 0;
        await executeCommand(cmd);
        return;
    }

    // ── /reddit [sub] [sort] ──────────────────────────────────────
    if (lower.startsWith('/reddit')) {
        const parts = input.trim().split(/\s+/);
        const sub  = parts[1] || 'popular';
        const sort = ['hot','new','top','rising'].includes(parts[2]) ? parts[2] : 'hot';
        const cmd  = { type: 'reddit', sub, sort };
        state.currentSession.lastCommand = cmd;
        state.currentSession.page = 0;
        await executeCommand(cmd);
        return;
    }

    // ── Category commands: /news /tech /science /finance /culture ─
    const catKeys = Object.keys(CAT_LABELS);
    if (catKeys.includes(lower.slice(1))) {
        const cat = lower.slice(1);
        const cmd = { type: 'feedcat', cat };
        state.currentSession.lastCommand = cmd;
        state.currentSession.page = 0;
        await executeCommand(cmd);
        return;
    }

    // ── Specific feed command: /bbc /hn /ars /verge etc. ─────────
    const feedKey = lower.slice(1); // strip leading slash
    if (FEEDS[feedKey]) {
        const cmd = { type: 'feed', key: feedKey, cat: FEEDS[feedKey].cat };
        state.currentSession.lastCommand = cmd;
        state.currentSession.page = 0;
        await executeCommand(cmd);
        return;
    }

    // ── Natural language (context-aware follow-up) ────────────────
    await handleNaturalLanguage(input);
}

// ================================================================
//  COMMAND EXECUTOR
// ================================================================

async function executeCommand(cmd) {
    const tid = showThinking();
    try {
        let md = '';

        if (cmd.type === 'reddit') {
            md = await fetchReddit(cmd.sub, cmd.sort, state.currentSession.page);

        } else if (cmd.type === 'feed') {
            // Specific feed: /next cycles through the rest of its category
            const keys     = getCatKeys(cmd.cat);
            const startIdx = Math.max(0, keys.indexOf(cmd.key));
            const idx      = (startIdx + state.currentSession.page) % keys.length;
            md = await fetchFeedByKey(keys[idx]);

        } else if (cmd.type === 'feedcat') {
            // Category command: cycle through feeds in this category
            const keys = getCatKeys(cmd.cat);
            const idx  = state.currentSession.page % keys.length;
            md = await fetchFeedByKey(keys[idx]);
        }

        hideThinking(tid);
        await addBotMessageAnimated(md);
    } catch (err) {
        hideThinking(tid);
        addBotMessage(
            `**Fetch error:** ${escapeHtml(err.message)}\n\n` +
            `Try \`/sources\` to see all available feeds, or \`/next\` to skip to the next source.`
        );
    }
}

/** Return ordered list of feed keys for a given category. */
function getCatKeys(cat) {
    return Object.keys(FEEDS).filter(k => FEEDS[k].cat === cat);
}

// ================================================================
//  REDDIT FETCHER
// ================================================================

async function fetchReddit(subreddit, sort = 'hot', page = 0) {
    const after = page > 0 && state.currentSession.lastData?.after
        ? `&after=${state.currentSession.lastData.after}` : '';
    const url = `https://www.reddit.com/r/${subreddit}/${sort}.json?limit=10${after}&raw_json=1`;

    const data = await fetchJSON(url);

    if (!data?.data?.children) {
        throw new Error('Unexpected Reddit response — subreddit may not exist or is private.');
    }

    const posts = data.data.children;

    state.currentSession.lastData = {
        after: data.data.after || '',
        posts: posts.map(p => ({
            title:        p.data.title,
            selftext:     p.data.selftext,
            author:       p.data.author,
            score:        p.data.score,
            num_comments: p.data.num_comments,
            subreddit:    p.data.subreddit,
        })),
    };
    saveSessions();

    let md = `## Reddit — r/${subreddit} (${sort})\n`;
    md += `*${posts.length} posts • page ${page + 1} • \`/next\` for more*\n\n---\n\n`;

    posts.forEach((post, i) => {
        const p = post.data;
        md += `### ${i + 1}. ${sanitizeText(p.title)}\n`;
        md += `*u/${p.author} • ${fmtScore(p.score)} points • ${p.num_comments} comments*\n\n`;
        if (p.selftext && p.selftext.trim().length > 10) {
            const body = p.selftext.length > 600 ? p.selftext.slice(0, 600).trimEnd() + '…' : p.selftext;
            md += `${sanitizeText(body)}\n\n`;
        }
        md += `---\n\n`;
    });

    md += `*Ask "summarize the top posts" or "more about post 3" — or type \`/next\`*`;
    return md;
}

// ================================================================
//  RSS FEED FETCHER  (via rss2json.com)
// ================================================================

async function fetchFeedByKey(key) {
    const feed = FEEDS[key];
    if (!feed) throw new Error(`Unknown feed: ${key}`);

    const apiUrl = RSS2JSON + encodeURIComponent(feed.url);
    let data;

    try {
        const res = await fetch(apiUrl, {
            signal: AbortSignal.timeout ? AbortSignal.timeout(14000) : undefined,
        });
        data = await res.json();
    } catch (e) {
        throw new Error(`Could not reach rss2json for ${feed.name}: ${e.message}`);
    }

    if (data.status !== 'ok') {
        throw new Error(`${feed.name}: ${data.message || 'feed unavailable'}`);
    }

    const items = (data.items || []).slice(0, 15);
    if (!items.length) throw new Error(`No articles found in ${feed.name}`);

    // Show the current feed name and which category it belongs to
    const catLabel = CAT_LABELS[feed.cat] || feed.cat;
    let md = `## ${feed.name}  *(${catLabel})*\n`;
    md += `*${new Date().toLocaleString()} • \`/next\` cycles to the next source*\n\n---\n\n`;

    items.forEach((item, i) => {
        const title  = cleanHtml(item.title  || 'Untitled');
        const desc   = cleanHtml(item.description || item.content || '');
        const author = item.author ? item.author.trim() : '';
        const pub    = item.pubDate || '';

        md += `### ${i + 1}. ${title}\n`;

        const meta = [];
        if (pub)    { try { meta.push(new Date(pub).toLocaleString()); } catch (_) {} }
        if (author) meta.push(`by ${author}`);
        if (meta.length) md += `*${meta.join(' · ')}*\n\n`;

        if (desc.length > 20) {
            md += `${desc.slice(0, 420)}${desc.length > 420 ? '…' : ''}\n\n`;
        }

        md += `---\n\n`;
    });

    return md;
}

// ================================================================
//  REDDIT FETCH HELPERS  (with CORS proxy fallback)
// ================================================================

async function fetchJSON(url) {
    return JSON.parse(await fetchText(url));
}

async function fetchText(url) {
    try {
        const res = await fetch(url, {
            signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
        });
        if (res.ok) return await res.text();
    } catch (_) {}

    for (const proxy of PROXIES) {
        try {
            const res = await fetch(proxy + encodeURIComponent(url), {
                signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
            });
            if (res.ok) return await res.text();
        } catch (_) {}
    }

    throw new Error('All network paths failed — check your connection.');
}

// ================================================================
//  NATURAL LANGUAGE HANDLER
// ================================================================

async function handleNaturalLanguage(input) {
    const posts = state.currentSession.lastData?.posts;
    const lower = input.toLowerCase();

    if (!posts) {
        await respondWith(getHelpText(), 500);
        return;
    }

    const tid = showThinking();
    await delay(700 + Math.random() * 1000);
    hideThinking(tid);

    const numMatch = lower.match(/(?:post|#|number)\s*(\d+)/);
    const postIdx  = numMatch ? parseInt(numMatch[1], 10) - 1 : null;

    // summarize / tldr
    if (lower.includes('summar') || lower.includes('tldr') || lower.includes('summary')) {
        if (postIdx !== null && posts[postIdx]) {
            const p = posts[postIdx];
            let md = `## Summary — Post ${postIdx + 1}\n\n**"${p.title}"**\n`;
            md += `*u/${p.author} • ${fmtScore(p.score)} points*\n\n`;
            md += p.selftext?.trim().length > 20
                ? sanitizeText(p.selftext.slice(0, 1200))
                : '*Link post — no text body available.*';
            await addBotMessageAnimated(md);
        } else {
            let md = `## Top ${Math.min(posts.length, 10)} Posts\n\n`;
            posts.slice(0, 10).forEach((p, i) => {
                md += `**${i + 1}.** ${p.title}  \n*${fmtScore(p.score)} pts • ${p.num_comments} comments*\n\n`;
            });
            await addBotMessageAnimated(md);
        }
        return;
    }

    // details about a specific post
    if ((lower.includes('more') || lower.includes('detail') || lower.includes('about')) && postIdx !== null) {
        if (posts[postIdx]) {
            const p = posts[postIdx];
            let md = `## Post ${postIdx + 1}: ${p.title}\n\n`;
            md += `- **Author:** u/${p.author}\n- **Score:** ${fmtScore(p.score)}\n`;
            md += `- **Comments:** ${p.num_comments}\n- **Subreddit:** r/${p.subreddit}\n\n`;
            md += p.selftext?.trim().length > 20
                ? `---\n\n${sanitizeText(p.selftext)}`
                : '*Link post — no text body available.*';
            await addBotMessageAnimated(md);
        } else {
            await addBotMessageAnimated(`No post #${postIdx + 1} loaded. Type \`/next\` to fetch more.`);
        }
        return;
    }

    await addBotMessageAnimated(
        `I have **${posts.length} posts** loaded. Try:\n\n` +
        `- "summarize the top posts"\n- "tell me more about post 3"\n\n` +
        `Or use a command — type \`/sources\` to see everything available.`
    );
}

// ================================================================
//  UI — MESSAGE RENDERERS
// ================================================================

function addUserMessage(text) {
    const s = state.currentSession;
    s.messages.push({ role: 'user', content: text, id: Date.now() });
    if (s.title === 'New Chat') {
        const clean = text.replace(/^\/\S*\s*/, '').trim();
        s.title = (clean || text).slice(0, 42);
    }
    saveSessions();
    renderMessages();
    renderSidebar();
}

function addBotMessage(markdown) {
    state.currentSession.messages.push({ role: 'assistant', content: markdown, id: Date.now() });
    saveSessions();
    renderMessages();
    scrollBottom();
}

async function addBotMessageAnimated(markdown) {
    const id = Date.now();
    state.currentSession.messages.push({ role: 'assistant', content: '', id, streaming: true });
    renderMessages();

    const el = document.getElementById(`msg-${id}`);
    if (!el) { addBotMessage(markdown); return; }

    await typeText(el.querySelector('.message-content'), markdown);

    const msg = state.currentSession.messages.find(m => m.id === id);
    if (msg) { msg.content = markdown; msg.streaming = false; }
    saveSessions();
}

async function respondWith(markdown, thinkMs = 0) {
    const tid = showThinking();
    await delay(thinkMs);
    hideThinking(tid);
    await addBotMessageAnimated(markdown);
}

// ── Typing animation ─────────────────────────────────────────────

async function typeText(element, text) {
    // Reading mode: render instantly (no animation) — better for book reading
    if (getRenderMode() === 'reading') {
        element.innerHTML = renderMarkdown(text);
        scrollBottom();
        return;
    }

    // Response mode (default): token-by-token streaming animation
    const tokens = text.split(/(\s+)/);
    let accumulated = '';
    const BATCH = 6;

    for (let i = 0; i < tokens.length; i += BATCH) {
        accumulated += tokens.slice(i, i + BATCH).join('');
        element.innerHTML = renderMarkdown(accumulated) + '<span class="cursor"></span>';
        scrollBottom();
        const chunk = tokens.slice(i, i + BATCH).join('');
        await delay(chunk.includes('\n\n') ? 40 : 18);
    }

    element.innerHTML = renderMarkdown(text);
    scrollBottom();
}

// ── Thinking dots indicator ──────────────────────────────────────

function showThinking() {
    const id        = `thinking-${Date.now()}`;
    const container = document.getElementById('messages');
    const welcome   = container.querySelector('.welcome');
    if (welcome) welcome.style.display = 'none';

    const div = document.createElement('div');
    div.id        = id;
    div.className = 'message assistant';
    div.innerHTML = `
        <div class="bot-avatar"><img src="assets/images/chatgpt.png" alt="ChatGPT"></div>
        <div class="message-content">
            <div class="thinking-dots"><span></span><span></span><span></span></div>
        </div>`;
    container.appendChild(div);
    scrollBottom();
    return id;
}

function hideThinking(id) { document.getElementById(id)?.remove(); }

// ── Full message list re-render ──────────────────────────────────

function renderMessages() {
    const session   = state.currentSession;
    const container = document.getElementById('messages');
    if (!container) return;

    container.innerHTML = '';

    if (!session || session.messages.length === 0) {
        container.appendChild(buildWelcome());
        return;
    }

    session.messages.forEach(msg => {
        const div = document.createElement('div');
        div.id        = `msg-${msg.id}`;
        div.className = `message ${msg.role}`;

        if (msg.role === 'user') {
            div.innerHTML = `<div class="user-bubble">${escapeHtml(msg.content)}</div>`;
        } else {
            div.innerHTML = `
                <div class="bot-avatar"><img src="assets/images/chatgpt.png" alt="ChatGPT"></div>
                <div class="message-content">${msg.streaming ? '' : renderMarkdown(msg.content)}</div>`;
        }

        container.appendChild(div);
    });

    scrollBottom();
}

function buildWelcome() {
    const div = document.createElement('div');
    div.className = 'welcome';
    div.innerHTML = `
        <img src="assets/images/chatgpt.png" alt="ChatGPT" class="welcome-logo">
        <h1 class="welcome-title">What can I help with?</h1>
        <div class="welcome-chips">
            <button class="chip" data-cmd="/epub">Open a book</button>
            <button class="chip" data-cmd="/bbc">BBC News</button>
            <button class="chip" data-cmd="/hn">Hacker News</button>
            <button class="chip" data-cmd="/tech">Tech feeds</button>
            <button class="chip" data-cmd="/news">World news</button>
            <button class="chip" data-cmd="/science">Science</button>
            <button class="chip" data-cmd="/random">Surprise me</button>
            <button class="chip" data-cmd="/sources">All sources</button>
        </div>`;
    div.querySelectorAll('.chip').forEach(btn =>
        btn.addEventListener('click', () => handleInput(btn.dataset.cmd))
    );
    return div;
}

// ── Sidebar ──────────────────────────────────────────────────────

function renderSidebar() {
    const container = document.getElementById('chatHistory');
    if (!container) return;

    container.innerHTML = '';
    if (!state.sessions.length) return;

    const label = document.createElement('span');
    label.className   = 'history-section-label';
    label.textContent = 'Recent';
    container.appendChild(label);

    state.sessions.forEach(session => {
        const div = document.createElement('div');
        div.className = 'history-item' + (state.currentSession?.id === session.id ? ' active' : '');
        div.textContent = session.title;
        div.title = session.title;
        div.addEventListener('click', () => switchSession(session.id));
        container.appendChild(div);
    });
}

function scrollBottom() {
    const el = document.getElementById('messages');
    if (el) el.scrollTop = el.scrollHeight;
}

// ================================================================
//  MARKDOWN RENDERER  (zero dependencies)
// ================================================================

function renderMarkdown(text) {
    if (!text) return '';

    const lines   = text.split('\n');
    const out     = [];
    let inCode    = false, codeLang = '', codeLines = [];
    let listType  = null, listItems = [];

    function flushList() {
        if (!listType) return;
        out.push(`<${listType}>`);
        listItems.forEach(item => out.push(`<li>${inlineMd(item)}</li>`));
        out.push(`</${listType}>`);
        listType = null; listItems = [];
    }

    for (const line of lines) {
        if (line.startsWith('```')) {
            if (inCode) {
                out.push(`<pre><code class="lang-${codeLang}">${escapeHtml(codeLines.join('\n'))}</code></pre>`);
                inCode = false; codeLines = []; codeLang = '';
            } else {
                flushList(); inCode = true; codeLang = line.slice(3).trim();
            }
            continue;
        }
        if (inCode) { codeLines.push(line); continue; }

        const isUl = /^[-*]\s/.test(line);
        const isOl = /^\d+\.\s/.test(line);
        if (!isUl && !isOl) flushList();

        if      (line.startsWith('### ')) out.push(`<h3>${inlineMd(line.slice(4))}</h3>`);
        else if (line.startsWith('## '))  out.push(`<h2>${inlineMd(line.slice(3))}</h2>`);
        else if (line.startsWith('# '))   out.push(`<h1>${inlineMd(line.slice(2))}</h1>`);
        else if (/^---+$/.test(line.trim())) out.push('<hr>');
        else if (line.startsWith('> '))   out.push(`<blockquote>${inlineMd(line.slice(2))}</blockquote>`);
        else if (isUl) {
            if (listType !== 'ul') { flushList(); listType = 'ul'; }
            listItems.push(line.replace(/^[-*]\s/, ''));
        }
        else if (isOl) {
            if (listType !== 'ol') { flushList(); listType = 'ol'; }
            listItems.push(line.replace(/^\d+\.\s/, ''));
        }
        else if (line.trim() === '') out.push('<br>');
        else out.push(`<p>${inlineMd(line)}</p>`);
    }

    if (inCode && codeLines.length)
        out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    flushList();

    return out.join('');
}

function inlineMd(text) {
    text = text.replace(/!\[.*?\]\(.*?\)/g, '');                                     // strip images
    text = text.replace(/`([^`]+)`/g, (_, c) => `<code>${escapeHtml(c)}</code>`);   // inline code
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');                    // bold
    text = text.replace(/\*(.+?)\*/g,     '<em>$1</em>');                            // italic
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');                             // links → text only
    return text;
}

// ================================================================
//  UTILITIES
// ================================================================

function escapeHtml(str) {
    return String(str)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** Strip HTML tags and entities from rss2json description fields. */
function cleanHtml(html) {
    if (!html) return '';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.body.textContent.replace(/\s+/g, ' ').trim();
}

/** Strip image markdown and bare URLs from Reddit selftext. */
function sanitizeText(str) {
    if (!str) return '';
    return str
        .replace(/!\[.*?\]\(.*?\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function fmtScore(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
function delay(ms)   { return new Promise(r => setTimeout(r, ms)); }

// ================================================================
//  SETTINGS  (render mode)
// ================================================================

/**
 * 'reading'  — render entire block at once (instant, no animation)
 * 'response' — token-by-token animation (default)
 */
function getRenderMode() {
    return localStorage.getItem('pgb_render_mode') || 'response';
}

function setRenderMode(mode) {
    localStorage.setItem('pgb_render_mode', mode);
}

// ================================================================
//  EPUB TOOLBAR  (show/update the nav strip above the input box)
// ================================================================

/**
 * Show the EPUB toolbar and update its contents to reflect the
 * current reading position, or hide it if no book is open.
 * Called after every epub navigation and on session switch.
 */
function updateEpubToolbar() {
    const toolbar = document.getElementById('epubToolbar');
    if (!toolbar) return;

    const epub = state.currentSession?.epubData;
    if (!epub) {
        toolbar.style.display = 'none';
        return;
    }

    toolbar.style.display = 'block';

    const ch    = epub.chapters[epub.chapterIdx];
    const global = globalPageNum(epub); // defined in epub.js
    const total  = epub.chapters.reduce((s, c) => s + c.chunks.length, 0);
    const pct    = total > 1 ? Math.round((global - 1) / (total - 1) * 100) : 100;

    const nameEl     = document.getElementById('epubChapterName');
    const pageEl     = document.getElementById('epubPageNum');
    const progressEl = document.getElementById('epubProgressFill');

    if (nameEl)     nameEl.textContent     = ch?.title || '';
    if (pageEl)     pageEl.textContent     = `p. ${global} / ${total}`;
    if (progressEl) progressEl.style.width = `${pct}%`;
}

// ================================================================
//  HELP & SOURCES TEXT
// ================================================================

function getHelpText() {
    return `## ChatGPT Browser — Command Reference

**EPUB Reader**
- \`/epub\` — open a .epub file from your computer
- \`/next\` \`/prev\` — turn the page forward / backward
- \`/toc\` — table of contents
- \`/chapter N\` — jump to chapter N
- \`/goto N\` — jump to global page N
- \`/bookmark\` — show your last saved position

**Reddit**
- \`/reddit\` — r/popular (hot)
- \`/reddit worldnews\` — any subreddit
- \`/reddit science top\` — with sort: hot · new · top · rising
- \`/random\` — random subreddit

**News**
- \`/news\` — cycle through news sources
- \`/bbc\` \`/guardian\` \`/npr\` \`/nyt\` \`/aj\`

**Tech**
- \`/tech\` — cycle through tech sources
- \`/hn\` \`/ars\` \`/tc\` \`/verge\` \`/wired\` \`/slashdot\` \`/lobsters\` \`/mit\`

**Science**
- \`/science\` — cycle through science sources
- \`/nasa\` \`/quanta\` \`/sciencedaily\` \`/phys\`

**Finance & Culture**
- \`/finance\` → \`/marketwatch\`
- \`/culture\` → \`/longreads\` \`/atlantic\`

**Navigation**
- \`/next\` — next page (book or feed)
- \`/sources\` — full source listing
- \`/clear\` — clear chat
- \`/help\` — this message`;
}

function getSourcesList() {
    const cats = {};
    Object.entries(FEEDS).forEach(([key, feed]) => {
        if (!cats[feed.cat]) cats[feed.cat] = [];
        cats[feed.cat].push({ key, name: feed.name });
    });

    let md = '## All Available Sources\n\n';

    Object.entries(cats).forEach(([cat, feeds]) => {
        md += `### ${CAT_LABELS[cat] || cat}\n`;
        feeds.forEach(({ key, name }) => {
            md += `- \`/${key}\` — ${name}\n`;
        });
        md += '\n';
    });

    md += '### Reddit\n';
    md += '- `/reddit <subreddit>` — any public subreddit\n';
    md += '- `/random` — random pick from a curated list\n\n';
    md += '**Category shortcuts** rotate through all sources in that group:\n';
    md += Object.entries(CAT_LABELS).map(([k, v]) => `\`/${k}\``).join(' · ') + '\n\n';
    md += '*After any command, \`/next\` jumps to the next source in the same category.*';

    return md;
}
