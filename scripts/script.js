// ================================================================
// script.js — UI event wiring
//
// Attaches all DOM event listeners after the page loads.
// browser.js must be loaded first — it defines initApp(),
// createNewSession(), handleInput(), and all render functions.
// ================================================================

document.addEventListener('DOMContentLoaded', () => {

    // ── Element refs ─────────────────────────────────────────────
    const chatInput      = document.getElementById('chatInput');
    const sendBtn        = document.getElementById('sendBtn');
    const sendIcon       = document.getElementById('sendIcon');
    const voiceIcon      = document.getElementById('voiceIcon');
    const newChatBtn     = document.getElementById('newChatBtn');     // icon in sidebar top
    const newChatBtn2    = document.getElementById('newChatBtn2');    // labelled button
    const sidebarToggle  = document.getElementById('sidebarToggle');
    const sidebar        = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const helpBtn        = document.getElementById('helpBtn');
    const messagesEl     = document.getElementById('messages');

    // ── Boot the app (defined in browser.js) ─────────────────────
    initApp();

    // ── Send-button state: mic when empty, arrow when text ────────
    function updateSendBtn() {
        const hasText = chatInput.value.trim().length > 0;
        sendIcon.style.display  = hasText ? 'block' : 'none';
        voiceIcon.style.display = hasText ? 'none'  : 'block';
        sendBtn.className       = `send-btn ${hasText ? 'active' : 'inactive'}`;
    }

    updateSendBtn(); // set correct initial state

    // Auto-grow textarea as the user types
    chatInput.addEventListener('input', () => {
        updateSendBtn();
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + 'px';
    });

    // ── Enter to send, Shift+Enter for newline ────────────────────
    chatInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    });

    sendBtn.addEventListener('click', send);

    function send() {
        const text = chatInput.value.trim();
        if (!text) return;

        // Reset input immediately for responsive feel
        chatInput.value = '';
        chatInput.style.height = 'auto';
        updateSendBtn();

        // handleInput is defined in browser.js
        handleInput(text);
    }

    // ── New chat ──────────────────────────────────────────────────
    [newChatBtn, newChatBtn2].forEach(btn => {
        btn?.addEventListener('click', () => {
            createNewSession(); // defined in browser.js
            chatInput.focus();
        });
    });

    // ── Sidebar toggle (desktop: collapse; mobile: slide-in) ──────
    sidebarToggle?.addEventListener('click', () => {
        if (window.innerWidth <= 768) {
            sidebar.classList.toggle('mobile-open');
            sidebarOverlay.classList.toggle('visible');
        } else {
            sidebar.classList.toggle('collapsed');
        }
    });

    // Close mobile sidebar when overlay is tapped
    sidebarOverlay?.addEventListener('click', () => {
        sidebar.classList.remove('mobile-open');
        sidebarOverlay.classList.remove('visible');
    });

    // ── "Browse" button → show /help ─────────────────────────────
    helpBtn?.addEventListener('click', () => handleInput('/help'));

    // ── Delegate chip clicks in the messages area ─────────────────
    // (Chips are built dynamically by buildWelcome() in browser.js)
    messagesEl?.addEventListener('click', e => {
        const chip = e.target.closest('.chip');
        if (chip?.dataset.cmd) handleInput(chip.dataset.cmd);
    });

    // ── Settings panel ───────────────────────────────────────────
    const settingsBtn      = document.getElementById('settingsBtn');
    const settingsPanel    = document.getElementById('settingsPanel');
    const readingModeCheck = document.getElementById('readingModeCheck');

    // Restore checkbox state from localStorage
    if (readingModeCheck) {
        readingModeCheck.checked = getRenderMode() === 'reading'; // getRenderMode defined in browser.js
    }

    settingsBtn?.addEventListener('click', () => {
        settingsPanel?.classList.toggle('open');
    });

    readingModeCheck?.addEventListener('change', () => {
        setRenderMode(readingModeCheck.checked ? 'reading' : 'response');
    });

    // ── EPUB toolbar buttons ──────────────────────────────────────
    document.getElementById('epubPrevBtn')?.addEventListener('click', () => {
        handleInput('/prev');
    });

    document.getElementById('epubNextBtn')?.addEventListener('click', () => {
        handleInput('/next');
    });

    document.getElementById('epubTocBtn')?.addEventListener('click', () => {
        handleInput('/toc');
    });

    // Goto: pre-fill input with "/goto " so user just types the page number
    document.getElementById('epubGotoBtn')?.addEventListener('click', () => {
        chatInput.value = '/goto ';
        chatInput.focus();
        chatInput.dispatchEvent(new Event('input')); // triggers updateSendBtn()
    });

    // ── Auto-focus the input on load ──────────────────────────────
    chatInput.focus();
});
