// Xift content script: reads X's timeline, asks the background about each post, and collapses the noise.
// Marks are data-sift attributes plus Xift's own bar and button elements; removing them restores X's page.
// The Node tests require() this file for pathMode and decide; the browser part runs only in Firefox.
(() => {
    const FILTER_PATHS = /^\/(home|search|i\/lists\/\d+)$/;
    // A post's own page, where its replies are judged: /<handle>/status/<id>, or /i/web/status/<id> without the handle.
    const POST_PATH = /^\/(?:i\/web|(\w{1,15}))\/status\/(\d{1,25})$/;
    // Modal routes keep the timeline mounted underneath, so Xift freezes there instead of removing marks.
    const FREEZE_PATHS = /\/(photo|video)\/\d+$|^\/compose\/post$/;

    function pathMode(path) {
        if (FREEZE_PATHS.test(path)) return "freeze";
        if (FILTER_PATHS.test(path)) return "filter";
        return POST_PATH.test(path) ? "post" : "off";
    }

    // On a post's page, whether a post there is judged: a reply below it, which has a newer ID (X's IDs grow with time,
    // and the posts shown above it, what it replies to, are older), and not by its author (author: the handle, or null
    // when unknown), whose own replies are its thread. IDs pass 2^53, so they're compared as BigInts.
    function replyJudged(path, id, handle, author) {
        const m = path.match(POST_PATH);
        if (!m || !/^\d{1,25}$/.test(String(id)) || BigInt(id) <= BigInt(m[2])) return false;
        return !author || String(handle ?? "").replace(/^@/, "").toLowerCase() !== author.replace(/^@/, "").toLowerCase();
    }

    // What a cell holding a post should look like now, and whether to ask about it.
    //   verdict: { collapsed, label } from SiftVerdict, once an answer has arrived
    //   current: the cell's data-sift right now
    //   above: the cell's top edge is above the viewport (measured only for a collapse arriving late)
    //   deferred: this node already had a late collapse deferred for this post
    //   peeked: you opened this post with Show
    //   held: the post you're on has keyboard focus, and you didn't hide it yourself
    //   retried: Jev failed on this post before; it stays open while it's asked again, so a failing Jev never blurs the
    //     page every minute
    //   waitingOpen: this cell shows this post open while it's asked again; you may be reading it, so a late collapse
    //     waits for X to remount it, wherever it is
    function decide({ verdict, current = null, above = false, deferred = false, inFlight = false, coolingDown = false, retried = false, waitingOpen = false, peeked = false, held = false }) {
        const mark = (sift, label = null, extra) => ({ sift, label, send: false, defer: false, ...extra });
        if (verdict?.collapsed && !peeked) {
            if (deferred) return mark(null);
            // A collapse landing on a post already scrolled past would move the page, and one landing on the post
            // you're on would pull it from under you: leave it open until X remounts it.
            if ((current === "pending" && above) || (waitingOpen && current === null) || (held && current !== "collapsed")) return mark(null, null, { defer: true });
            return mark("collapsed", verdict.label);
        }
        if (verdict) return mark(null);
        if (coolingDown) return mark(null); // fail open: a post Jev didn't judge is never collapsed
        if (retried) return mark(null, null, { send: !inFlight });
        return mark("pending", null, { send: !inFlight }); // includes a reused cell still showing another post's bar
    }

    // The scores a keep or hide may learn from: Jev's own, never those of a post you already corrected, so toggling one
    // post can't step a threshold again and again. Nor scores judged with a photo, until they're calibrated: they run
    // about 0.10 higher on bait than the text-only scores the thresholds learned from (2026-10-16 re-run).
    const learnableScores = (answer) => (answer?.byYou || answer?.photo ? undefined : answer?.scores);

    // Where j (dir 1) or k (dir -1) goes: the index of the next open post, skipping bars and the replies hidden
    // with them, or -1 when none is loaded that way. cells: { open, top } in page order; from: the post you're on,
    // or -1 for none, when j starts at the first post under the header (bottom edge at header) and k at the one above.
    function pick(cells, from, dir, header) {
        if (from < 0) {
            const under = (cell) => cell.top >= header - 2; // X's own j leaves a post 1px under the header
            return dir > 0 ? cells.findIndex((cell) => cell.open && under(cell)) : cells.findLastIndex((cell) => cell.open && !under(cell));
        }
        for (let i = from + dir; i >= 0 && i < cells.length; i += dir) if (cells[i].open) return i;
        return -1;
    }

    // Focus mode's reading line, a third of the way down the timeline under X's header: where the post you read
    // with the wheel hands over to the next one.
    const readingLine = (header, height) => header + (height - header) / 3;

    // Where the current post ends, as positions on screen, recorded when it becomes current. Going down, it ends when
    // its bottom rises above the reading line, or above the header if it was already above the line (a short post).
    // Going up, when its top falls 48 px below the line, or 48 px below where it was if that was further down: the
    // slack keeps a small reversal at a hand-over from flipping posts back and forth.
    function exitEdges(post, line, header) {
        return { down: post.bottom >= line ? line : header, up: Math.max(post.top, line) + 48 };
    }

    // Reading with the wheel: 1 when a scroll down (dir 1) has carried the current post past its edge going down,
    // -1 when a scroll up has carried it past its edge going up, else 0. post: { top, bottom } on screen now.
    function readOn(post, edges, dir) {
        if (dir > 0 && post.bottom < edges.down) return 1;
        if (dir < 0 && post.top > edges.up) return -1;
        return 0;
    }

    // The post focus mode puts you on, as an index into cells ({ open, top, bottom } in page order), or -1 for none.
    // from: the post you were on, kept if its top lies between the header and the reading line. Else the open post
    // across the line, else the first open post on screen under the header. top: the page is at the top or the
    // timeline was replaced, so start where j would, which never skips a short newest post.
    function focusPick(cells, from, line, header, innerHeight, top = false) {
        if (top) return pick(cells, -1, 1, header);
        const was = cells[from];
        if (was?.open && was.top >= header - 2 && was.top <= line) return from;
        const across = cells.findIndex((cell) => cell.open && cell.top <= line && cell.bottom >= line);
        if (across >= 0) return across;
        return cells.findIndex((cell) => cell.open && cell.top >= header - 2 && cell.top < innerHeight);
    }

    // Seen posts. Home skips a post you've seen when a cell starts holding it ahead of you, at or below X's header,
    // and you saw it before then: a post you read in this cell never collapses under you. A post skipped once stays
    // skipped. Never skipped: the post you're on (held), and the post you left for another page (left).
    // seenAt: when you saw it, or undefined; at: when the cell started holding it; ahead: its top was under the header then.
    function skipSeen({ seenAt, at, ahead, before = false, held = false, left = false }) {
        if (before) return true;
        if (held || left) return false;
        return ahead && seenAt !== undefined && seenAt < at;
    }

    // A Seen bar's label: the time for a post seen today, else the date in X's style, both in the same locale.
    function seenLabel(seenAt, now, locale) {
        const d = new Date(seenAt);
        const today = new Date(now);
        if (d.toDateString() === today.toDateString()) return `Seen ${d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}`;
        const year = d.getFullYear() === today.getFullYear() ? undefined : "numeric";
        return `Seen ${d.toLocaleDateString(locale, { month: "short", day: "numeric", year })}`;
    }

    // How long a post must be what you're reading before it counts as seen.
    const SEEN_MS = 1000;

    // Visible time. state: { ms, since }, since being when counting last resumed, or null while paused. Adds the time
    // since then, and resumes or pauses from now.
    function tally(state, counting, now) {
        const ms = state.ms + (state.since === null ? 0 : now - state.since);
        return { ms, since: counting ? now : null };
    }

    // With focus mode off, a post is on screen to read when all of it is between X's header and the window's bottom,
    // or, for a post taller than half the timeline, while it covers at least half of the timeline.
    function readable(box, header, height) {
        const half = (height - header) / 2;
        if (box.bottom - box.top > half) return Math.min(box.bottom, height) - Math.max(box.top, header) >= half;
        return box.top >= header - 2 && box.bottom <= height;
    }

    // Focus mode's seen rule, one check: watch is { id, ms, since } for the current post, which starts from 0 when it
    // changes. It counts while the tab is visible, you've touched the page since it loaded, and the post is open.
    // record: it has just reached SEEN_MS (once per stay); wait: ms until it would, while counting, else null.
    function focusStep(watch, { id, visible, touched, open }, now) {
        const counting = Boolean(id) && visible && touched && open;
        const next = { id, ...tally(id === watch.id ? watch : { ms: 0, since: null }, counting, now) };
        if (next.ms >= SEEN_MS) return { watch: { id, ms: -Infinity, since: null }, record: true, wait: null };
        return { watch: next, record: false, wait: counting ? SEEN_MS - next.ms : null };
    }

    // Focus mode off, one post, one check: was is its { ms, since }, or undefined. Scrolled off the top, it's recorded
    // if it was on screen to read for SEEN_MS; below the window it's forgotten; else its time adds up while it's
    // readable and counting (the tab visible, the post open). state: what to keep for it, or null to forget it.
    function passStep(was, box, header, height, counting, now) {
        if (box.bottom <= header) return { state: null, record: Boolean(was) && tally(was, false, now).ms >= SEEN_MS };
        if (box.top >= height) return { state: null, record: false };
        return { state: tally(was ?? { ms: 0, since: null }, counting && readable(box, header, height), now), record: false };
    }

    // j records the post it leaves: not k, not j held down (auto-repeat would mark every post it passes), and not
    // with no post to start from.
    const jRecords = (dir, repeat, start) => dir > 0 && !repeat && start;

    // The author's name and handle from X's User-Name text ("Name@handle·5h"). The handle is the last @word, or the
    // one given (from the profile link); the name is what comes before it, so an @ in a display name stays in the name.
    function userParts(text, handle = null) {
        const at = handle ?? [...text.matchAll(/@(\w{1,15})/g)].at(-1)?.[1] ?? "";
        const cut = at ? text.lastIndexOf(`@${at}`) : -1;
        return { name: (cut >= 0 ? text.slice(0, cut) : text).trim(), handle: at };
    }

    // What a judge reply means for this tab: when you saw the post (or null), whether Home should stop asking about
    // it (a reply that is only "seen"), the answer to keep, and whether to cool down. A failed judge cools down even
    // for a post you've seen, or the tab would ask again every frame.
    // stale: the reply was asked for before you cleared the Seen list, so its seen time is out of date: it's dropped,
    // and the post is asked about again.
    // until: a judge paused by the spending limit cools down until then (the 1st of next month, unless a reset or a new
    // limit ends it sooner), instead of for COOL_DOWN_MS.
    function replyOf(res, stale = false) {
        const answer = res?.byYou ? { byYou: res.byYou } : res?.trusted ? { trusted: true } : res?.tooLittle ? { tooLittle: true } : res?.scores ? (res.photo ? { scores: res.scores, photo: true } : { scores: res.scores }) : null;
        const seen = (!stale && res?.seen) || null;
        const until = Number.isFinite(res?.paused) ? res.paused : null;
        const failed = Boolean(res?.error) || until !== null;
        return { seen, told: Boolean(seen) && !answer && !failed, answer, coolDown: !answer && (failed || !res?.seen), until };
    }

    // A cell ahead of you: its top at or below X's header, and in line with its neighbours in X's order (the tops of
    // the nearest cells before and after it that have a height, null at either end). X can show a cell for a frame
    // at a place it then leaves; a cell out of line counts as not ahead, so a post you read shows rather than collapse.
    function aheadAt(prevTop, top, nextTop, header) {
        return top >= header - 2 && (prevTop === null || prevTop <= top + 1) && (nextTop === null || top <= nextTop + 1);
    }

    // Whether an image's alt text is a description someone wrote. X labels an image without one "Image" in your
    // language ("Bild", "Hình ảnh", "画像"…), 12 characters at most. ponytail: drops real descriptions that short too.
    const described = (alt) => alt.trim().length > 12;

    if (typeof module !== "undefined") {
        module.exports = { described, pathMode, replyJudged, decide, learnableScores, pick, readingLine, exitEdges, readOn, focusPick, skipSeen, seenLabel, tally, readable, SEEN_MS, replyOf, aheadAt, focusStep, passStep, jRecords, userParts };
        return;
    }

    // X selectors, in one place: X's own data-testid values where it has them, checked on live X.
    const SEL = {
        cell: '[data-testid="primaryColumn"] [data-testid="cellInnerDiv"]',
        post: 'article[data-testid="tweet"]',
        text: '[data-testid="tweetText"]',
        user: '[data-testid="User-Name"]',
        quote: 'div[role="link"]',
        photo: '[data-testid="tweetPhoto"] img',
        lock: '[data-testid="icon-lock"], svg[aria-label="Protected account"]',
        heading: 'h2[role="heading"]',
        avatar: '[data-testid="Tweet-User-Avatar"]',
        ad: '[data-testid="placementTracking"]', // around a promoted post; also inside video players, so test with closest()
    };
    const SETTING_KEYS = ["enabled", "collapseAds", "collapseLittleText", "judgeReplies", "thresholds", "focus", "focusWidth", "focusText", "trusted", "provider", "localModel"];
    const COOL_DOWN_MS = 60_000;
    const OPEN = { sift: null, label: null, post: false };
    const FOLLOW = { sift: "follow", label: null, post: false };

    let settings = SiftVerdict.settingsFrom({});
    let trusted = new Set(); // the authors you always show, as settings.trusted
    const isTrusted = (handle) => trusted.has(SiftVerdict.handleKey(handle));
    const answers = new Map(); // post ID → { scores } | { tooLittle } | { byYou, scores? }
    const inFlight = new Set(); // post IDs waiting for the background
    const failedUntil = new Map(); // post ID → time after which it may be sent again
    const deferred = new WeakMap(); // cell → post ID whose late collapse was deferred
    const openWaiting = new WeakMap(); // cell → post ID it shows open while Jev is asked again after a failure
    const inherited = new Set(); // reply IDs already logged as inherited
    const corrected = new Set(); // post IDs you corrected in this tab
    const peeked = new Set(); // post IDs you opened with Show
    const peekedAds = new WeakSet(); // ad articles you opened with Show (ads have no post ID)
    const postCache = new WeakMap(); // article → what readPost found in it
    let scheduled = false;
    let scrolls = 0; // counts Xift's own scrolls, which cancel anchor corrections measured before them
    let selected = null; // the cell j, k or h last moved to: focus falls to the page when a post collapses
    let afterChord = false; // the last key was X's g or a, so the next one belongs to X
    let scrolledFor = null; // the last post loaded when j or k last scrolled for more
    let navCancelled = false; // another key came with ⌥: no menu until ⌥ is released
    // Focus mode: one post at a time. The current post is `selected`, its cell marked data-sift-current; the mark
    // follows its post ID, because X reuses cells for other posts.
    let focusing = false; // focus mode is on for this page, also while ⌥ shows X's normal layout
    let picked = false; // a current post has been picked since focus mode started
    let currentId = null; // the current post's ID
    let focusHere = ""; // the page focus mode is on (path and query)
    let leftId = null; // the current post's ID when you left that page, to find it again when you come back
    let leftPath = ""; // the page you left it on
    let comingBack = 0; // until then, wait for X to mount the post you left
    let layout = ""; // the focus layout on the page now: "" or "width|text"
    let edges = null; // where the current post ends, for reading with the wheel
    let realign = 0; // the running re-align; your scrolling or a newer switch stops it
    let ownScroll = 0; // Xift's own scrolls until then never count as reading
    let scrolling = false; // a scroll is under way: re-picks wait until it settles, or the screen would strobe
    let settleTimer = 0;
    let altBreak = false; // ⌥ is showing X's normal layout while focus mode stays on
    let lastMode = ""; // pathMode at the last rescan
    let modalUntil = 0; // after a modal closes or you come back, X restores the page: no re-picks until then
    let altTimer = 0; // ⌥'s 100 ms wait before X's normal layout returns
    const pausedBySift = new WeakSet(); // videos Xift paused in hidden cells, to resume when their post is current
    const SCROLL_KEYS = new Set([" ", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End"]);
    let inputUntil = 0; // scroll events until then follow your input
    let canStep = false; // reading moves one post per wheel event or key press
    let dragging = false; // the scrollbar or middle-click autoscroll is held: each scroll event may move one post
    let lastY = 0; // scrollY at the previous scroll event
    // Seen posts. Home skips them; these are kept apart from answers, which hold Jev's verdicts only.
    const seenAt = new Map(); // post ID → when you saw it: the background's answers and the posts this tab recorded
    let cellSeen = new WeakMap(); // cell → { id, at, ahead }: when it started holding that post, and whether ahead of you
    const skippedHere = new Set(); // post IDs Home skipped in this tab
    const toldSeen = new Set(); // post IDs the background answered "seen" for: later requests don't ask again
    let leftSeen = { id: null, path: "" }; // the post you left a filter page from, and that page: never skipped there
    let opened = null; // the post you opened with a click or Enter, until you leave the page
    let lastFilterPath = ""; // the filter page you're on, or were last on
    let seenEpoch = 0; // counts Clear Seen list: a reply asked for before the latest clear has an out-of-date seen time
    const incognito = browser.extension?.inIncognitoContext === true; // a private window records nothing
    let hadInput = false; // a key, click or wheel on the page since it loaded: focus mode counts only after one
    let watch = { id: null, ms: 0, since: null }; // focus mode: the current post's visible time
    const passing = new Map(); // focus mode off: post ID → { ms, since } for the posts on screen
    const rememberedAt = new Map(); // post ID → when this tab last sent it: j and a scroll past send it once
    let seenTimer = 0;
    let seenFrame = 0;

    // X's left menu, the desktop one that holds the Home link. ⌥ + a number key opens an item. Each destination
    // has a fixed number, because X adds, drops and folds items into More with the window size.
    const MENU = 'header[role="banner"]:has([data-testid="AppTabBar_Home_Link"])';
    const NAV_KEYS = {
        Digit1: '[data-testid="AppTabBar_Home_Link"]',
        Digit2: '[data-testid="AppTabBar_Explore_Link"]',
        Digit3: '[data-testid="AppTabBar_Notifications_Link"]',
        Digit4: '[data-testid="AppTabBar_Follow_Link"]',
        Digit5: '[data-testid="AppTabBar_DirectMessage_Link"]',
        Digit6: '[data-testid="AppTabBar_Calls_Link"]',
        Digit7: 'a[href="/i/grok"]',
        Digit8: 'a[href="/i/history"]',
        Digit9: '[data-testid="AppTabBar_Profile_Link"]',
        Digit0: '[data-testid="SideNav_NewTweet_Button"]',
    };
    const navItem = (code) => document.querySelector(`${MENU} ${NAV_KEYS[code]}`);
    // X's right column, hidden with the menu and shown with it while ⌥ is held.
    const SIDE = '[data-testid="sidebarColumn"]';
    // Focus mode needs X's desktop layout in a window this wide, so the column's cap (100vw - 304px) never goes under
    // X's own 600 px.
    const FOCUS_MIN_WIDTH = 904;

    // Text with emoji kept: X draws emoji as <img alt="…">.
    function textOf(el) {
        let out = "";
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.nodeType === Node.TEXT_NODE) out += node.nodeValue;
            else if (node.nodeName === "IMG") out += node.alt;
        }
        return out.replace(/\s+/g, " ").trim();
    }

    // Adapted from Control Panel for Twitter's isReplyToPreviousTweet (MIT, © 2019 Jonny Buchanan):
    // a reply joined to the post above starts with X's 2px connector line.
    function isReplyToPrevious(article) {
        const line = article.firstElementChild?.firstElementChild?.firstElementChild?.firstElementChild?.firstElementChild?.firstElementChild;
        return Boolean(line) && getComputedStyle(line).width === "2px";
    }

    // On timelines the first <time> belongs to the main post, inside its /status/<id> link.
    const idOf = (article) => article.querySelector("time")?.closest('a[href*="/status/"]')?.getAttribute("href").match(/\/status\/(\d+)/)?.[1] ?? null;

    function readPost(article, id) {
        const user = article.querySelector(SEL.user);
        let text = "";
        let quoted = "";
        for (const el of article.querySelectorAll(SEL.text)) {
            const card = el.closest(SEL.quote);
            if (card && article.contains(card)) quoted ||= textOf(el);
            else text ||= textOf(el);
        }
        const handle = user?.querySelector('a[href^="/"]')?.getAttribute("href").slice(1) ?? "";
        return {
            id,
            protected: Boolean(article.querySelector(SEL.lock)), // its author's, or a quoted post's
            reply: isReplyToPrevious(article),
            author: user ? textOf(user).split("@")[0].trim() : "",
            handle: handle ? `@${handle}` : "",
            text,
            quoted,
            alt: altOf(article),
        };
    }

    // The image descriptions, which X fills in with the images, after the post itself: read again when the post is sent.
    const altOf = (article) => [...article.querySelectorAll(SEL.photo)].map((img) => img.alt).filter(described).join(" ");

    // Like textOf, with the post's line breaks kept (X writes them as text; <br> just in case).
    function linesOf(el) {
        let out = "";
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.nodeType === Node.TEXT_NODE) out += node.nodeValue;
            else if (node.nodeName === "IMG") out += node.alt;
            else if (node.nodeName === "BR") out += "\n";
        }
        return out.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    }

    // X's verified badge: gold for organisations (a gradient), grey for governments, else blue.
    function badgeOf(user) {
        const icon = user?.querySelector('[data-testid="icon-verified"]');
        if (!icon) return "";
        if (icon.querySelector("linearGradient")) return "gold";
        const { color, fill } = getComputedStyle(icon);
        return /130, 154, 171/.test(`${color} ${fill}`) ? "grey" : "blue";
    }

    // Up to 4 images or video posters, in order, each with the shape X shows it in, at X's small size.
    function mediaOf(all) {
        const boxes = all('[data-testid="tweetPhoto"], [data-testid="videoPlayer"]');
        const outer = boxes.filter((box) => !boxes.some((other) => other !== box && other.contains(box)));
        return outer.slice(0, 4).flatMap((box) => {
            const r = box.getBoundingClientRect();
            const video = box.querySelector("video");
            const src = video ? video.poster : box.querySelector("img")?.src;
            if (!src || !r.height) return [];
            const gif = Boolean(video) && /\bGIF\b/.test(box.textContent);
            return [{ kind: video ? (gif ? "gif" : "video") : "photo", src: src.replace(/([?&]name=)\w+/, "$1small"), ratio: r.width / r.height, label: gif ? "GIF" : "" }];
        });
    }

    // One post's fields for the Seen list. all(selector) lists the matches that belong to this post.
    function card(all) {
        const user = all(SEL.user)[0];
        // The main post's name links to the profile; a quoted post's doesn't, so its handle comes from the text.
        const linked = user?.querySelector('a[href^="/"]')?.getAttribute("href").slice(1);
        const { name, handle } = userParts(user ? textOf(user) : "", /^\w{1,15}$/.test(linked ?? "") ? linked : null);
        const time = all("time")[0];
        const text = all(SEL.text)[0];
        return {
            name: name.slice(0, 100),
            handle,
            avatar: all(`${SEL.avatar} img, img[src*="/profile_images/"]`)[0]?.src ?? "",
            badge: badgeOf(user),
            postedAt: time ? Date.parse(time.getAttribute("datetime")) || null : null,
            text: text ? linesOf(text).slice(0, 1000) : "",
            alt: all(SEL.photo).map((img) => img.alt).filter(described).join(" ").slice(0, 1000),
            media: mediaOf(all),
        };
    }

    // The post as the Seen list shows it, read fresh when you've seen it, by then with its images loaded. The
    // background checks every field again.
    function snapshot(article, id) {
        const quote = [...article.querySelectorAll(SEL.quote)].find((el) => el.querySelector(SEL.user));
        const own = (sel) => [...article.querySelectorAll(sel)].filter((el) => !quote?.contains(el));
        const inQuote = (sel) => [...quote.querySelectorAll(sel)];
        return { id, ...card(own), quoted: quote ? card(inQuote) : null };
    }

    // Sends the post in this cell to the Seen list: an open post, never an ad, a protected account's post or a post
    // with no ID, and never from a private window. Returns true when it counts (sent now or a moment ago).
    function remember(cell) {
        const article = cell?.querySelector(SEL.post);
        // Only Home, search and lists keep a Seen list: j on a post's page leaves its replies unrecorded.
        if (pathMode(location.pathname) !== "filter") return false;
        if (incognito || !settings.enabled || !article || cell.hasAttribute("data-sift") || article.closest(SEL.ad)) return false;
        const post = postOf(article);
        if (!post.id || post.protected) return false;
        const now = Date.now();
        if (now - (rememberedAt.get(post.id) ?? 0) < 5000) return true;
        const record = snapshot(article, post.id);
        if (!record.handle) return false; // X's markup changed: the background would drop it, so it doesn't count here either
        rememberedAt.set(post.id, now);
        seenAt.set(post.id, now);
        browser.runtime.sendMessage({ type: "seen", record }).catch(() => {});
        return true;
    }

    // The seen rule, checked at most once a frame while the page scrolls, after rescans, and when the tab is shown
    // or hidden. Focus mode: 1 s as the current post, once you've touched the page. Focus mode off: a post that
    // leaves the top after 1 s on screen to read. Only open posts count, and only while the tab is visible.
    function checkSeen() {
        clearTimeout(seenTimer);
        if (!settings.enabled || pathMode(location.pathname) !== "filter") {
            passing.clear();
            watch = { id: null, ms: 0, since: null };
            return;
        }
        const now = performance.now();
        const visible = !document.hidden;
        if (focusing) {
            passing.clear();
            const cell = selected?.isConnected && selected.hasAttribute("data-sift-current") ? selected : null;
            const id = cell ? postId(cell) : null;
            const step = focusStep(watch, { id, visible, touched: hadInput, open: Boolean(cell) && !cell.hasAttribute("data-sift") }, now);
            watch = step.watch;
            if (step.record) remember(cell);
            else if (step.wait !== null) seenTimer = setTimeout(checkSeen, step.wait + 20);
            return;
        }
        watch = { id: null, ms: 0, since: null };
        const header = headerBottom();
        const mounted = new Set();
        for (const cell of document.querySelectorAll(SEL.cell)) {
            const id = postId(cell);
            if (!id) continue;
            mounted.add(id);
            const step = passStep(passing.get(id), cell.getBoundingClientRect(), header, innerHeight, visible && !cell.hasAttribute("data-sift"), now);
            if (step.record) remember(cell);
            if (step.state) passing.set(id, step.state);
            else passing.delete(id);
        }
        for (const id of passing.keys()) if (!mounted.has(id)) passing.delete(id);
    }

    function queueSeen() {
        seenFrame ||= requestAnimationFrame(() => {
            seenFrame = 0;
            checkSeen();
        });
    }

    // The post ID is read on every rescan; the rest is read once per article and post.
    function postOf(article) {
        const id = idOf(article);
        let found = postCache.get(article);
        if (found?.id !== id) {
            found = id ? readPost(article, id) : { id: null };
            postCache.set(article, found);
        }
        return found;
    }

    function setMark(el, sift, label) {
        if (sift) el.setAttribute("data-sift", sift);
        else el.removeAttribute("data-sift");
        if (label) el.setAttribute("data-sift-label", label);
        else el.removeAttribute("data-sift-label");
    }

    const tall = (sift) => sift !== "collapsed" && sift !== "follow";

    // Keeps the first visible post where it is while marks change heights above it.
    function keepAnchor(change, moving = new Set()) {
        // A changing cell may anchor if its top is in view: its own height change never moves its top. Without this,
        // Show on the first post anchored on the post below and scrolled the opened post out of view.
        const anchor = [...document.querySelectorAll(SEL.cell)].find((cell) => {
            const r = cell.getBoundingClientRect();
            return r.bottom > 0 && (!moving.has(cell) || r.top >= 0);
        });
        const before = anchor?.getBoundingClientRect().top;
        const epoch = scrolls;
        change();
        if (!anchor) return;
        // Viewport positions, not page positions: Firefox's own scroll anchoring may already have compensated.
        requestAnimationFrame(() =>
            requestAnimationFrame(() => {
                if (!anchor.isConnected || epoch !== scrolls) return;
                const shift = anchor.getBoundingClientRect().top - before;
                if (Math.abs(shift) > 1) {
                    ownScroll = performance.now() + 100; // never counted as your reading
                    window.scrollBy(0, shift);
                }
            }),
        );
    }

    function stripAll() {
        selected = null;
        document.querySelectorAll("[data-sift-current]").forEach((el) => el.removeAttribute("data-sift-current"));
        document.querySelectorAll(".sift-fix, .sift-bar").forEach((el) => el.remove());
        const marked = document.querySelectorAll("[data-sift]");
        if (marked.length) keepAnchor(() => marked.forEach((el) => setMark(el, null, null)));
    }

    function apply(changes) {
        if (changes.length === 0) return;
        const run = () => changes.forEach((c) => setMark(c.cell, c.sift, c.label));
        const movesHeight = changes.some((c) => tall(c.sift) !== tall(c.cell.getAttribute("data-sift")));
        if (movesHeight) keepAnchor(run, new Set(changes.map((c) => c.cell)));
        else run();
    }

    function makeButton(act, text) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.act = act;
        button.textContent = text;
        button.setAttribute("aria-label", `Xift: ${text.toLowerCase()} this post`);
        return button;
    }

    // Round icon buttons drawn with SVG: ⊘ for hide, ✓ for keep, a person with ✓ for always showing the author.
    const ICONS = {
        hide: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z", "M5.6 5.6l12.8 12.8"],
        keep: ["M5 12.5l4.5 4.5L19 7.5"],
        trust: ["M9 4a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z", "M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6", "M15.5 11.5l2.2 2.2l4.3-4.6"],
    };

    function makeIconButton(act, title) {
        const button = makeButton(act, "");
        button.title = title;
        button.setAttribute("aria-label", title);
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        for (const d of ICONS[act]) {
            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute("d", d);
            svg.append(path);
        }
        button.append(svg);
        return button;
    }

    // Centre the button column under the avatar; a "reposted" or "pinned" line above the post moves it down.
    // A collapsed post has no laid-out avatar yet, so this is retried until it can measure. Only style changes,
    // never new elements, so retrying doesn't trigger another rescan.
    function placeFix(cell, fix) {
        const avatar = cell.querySelector(SEL.avatar)?.getBoundingClientRect();
        if (!avatar?.width) return;
        const box = cell.getBoundingClientRect();
        fix.style.top = `${Math.round(avatar.bottom - box.top + 8)}px`;
        fix.style.left = `${Math.round(avatar.left - box.left + avatar.width / 2 - 17)}px`;
        fix.dataset.placed = "1";
    }

    // Your buttons on open posts: Hide, plus Keep and Always show on a post you opened with Show. They sit under the
    // avatar, where X shows nothing, and outside the article, so a click never opens the post.
    function ensureFix(cell, id, canKeep, handle) {
        const canTrust = canKeep && Boolean(SiftVerdict.handleKey(handle)) && !isTrusted(handle);
        const sig = `${id}|${canKeep}|${canTrust}`;
        const existing = cell.querySelector(":scope > .sift-fix");
        if (existing?.dataset.sig === sig) {
            if (!existing.dataset.placed) placeFix(cell, existing);
            return;
        }
        existing?.remove();
        const fix = document.createElement("div");
        fix.className = "sift-fix";
        fix.dataset.sig = sig;
        fix.dataset.siftId = id;
        fix.dataset.siftHandle = handle;
        const hide = makeIconButton("hide", "Hide with Xift (h)");
        hide.setAttribute("aria-keyshortcuts", "h");
        fix.append(hide);
        if (canKeep) fix.append(makeIconButton("keep", "Keep with Xift"));
        if (canTrust) fix.append(makeIconButton("trust", `Always show ${handle}`));
        cell.append(fix);
        placeFix(cell, fix);
    }

    function noFix(cell, state) {
        cell.querySelector(":scope > .sift-fix")?.remove();
        return state;
    }

    // The one-line bar a collapsed post shows in its place.
    function ensureBar(cell, id, label, handle, canKeep) {
        const sig = `${id}|${label}|${handle}|${canKeep}`;
        const existing = cell.querySelector(":scope > .sift-bar");
        if (existing?.dataset.sig === sig) return;
        existing?.remove();
        const bar = document.createElement("div");
        bar.className = "sift-bar";
        bar.dataset.sig = sig;
        bar.dataset.siftId = id;
        const reason = document.createElement("span");
        reason.className = "sift-bar-reason";
        reason.textContent = label;
        const who = document.createElement("span");
        who.className = "sift-bar-who";
        who.textContent = handle;
        bar.append(reason, who, makeButton("show", "Show"));
        if (canKeep) bar.append(makeButton("keep", "Keep"));
        cell.append(bar);
    }

    // How long a post whose photo X hasn't loaded yet waits for it before going without; the cell stays blurred.
    const PHOTO_WAIT_MS = 3000;
    const photoWait = new WeakMap(); // article → { id, since }: when it started waiting for its post's photo

    // The post's own first photo, as X's image URL, read when the post is sent: "" for none, null while X hasn't added
    // the image yet. X mounts a post with the links to its photos (/status/<id>/photo/1) and adds the images a moment
    // later (probed 2026-10-16), so the link says there is one. Links carry the post's own ID, which leaves out a quoted
    // post's photos; videos link to /video/. A photo X shows blurred as sensitive isn't sent.
    function photoOf(article, id) {
        const link = article.querySelector(`a[href*="/status/${id}/photo/"]`);
        if (!link) return "";
        const img = link.querySelector("img");
        if (!img) return null;
        if (!img.src.startsWith("https://pbs.twimg.com/media/")) return "";
        for (let el = img; el && el !== link; el = el.parentElement) if (getComputedStyle(el).filter.includes("blur")) return "";
        return img.src;
    }

    // Whether a post has waited PHOTO_WAIT_MS for its photo in this article. The first call starts the wait, and a
    // rescan at its end. The wait belongs to the article: a post X unmounts and mounts again waits afresh.
    function photoWaited(article, id) {
        const wait = photoWait.get(article);
        if (wait?.id !== id) {
            photoWait.set(article, { id, since: Date.now() });
            setTimeout(schedule, PHOTO_WAIT_MS);
            return false;
        }
        return Date.now() - wait.since >= PHOTO_WAIT_MS;
    }

    // The author of the post whose page this is: read from that post (X marks it tabindex -1) while it's mounted, and
    // kept for the page, since it may scroll far above; else the handle in the address, unless the address names none
    // (/i/status/ from the Seen list, /i/web/status/). null when unknown.
    let pageAuthor = { path: null, handle: null };
    function postAuthor() {
        const path = location.pathname;
        const m = path.match(POST_PATH);
        if (!m) return null;
        if (pageAuthor.path !== path) pageAuthor = { path, handle: null };
        if (!pageAuthor.handle) {
            const own = document.querySelector(`[data-testid="primaryColumn"] ${SEL.post}[tabindex="-1"]`);
            const href = own?.querySelector(SEL.user)?.querySelector('a[href^="/"]')?.getAttribute("href") ?? "";
            pageAuthor.handle = SiftVerdict.handleKey(href.slice(1));
        }
        return pageAuthor.handle ?? (m[1] && m[1] !== "i" ? m[1].toLowerCase() : null);
    }

    // home: ask the background to answer "seen" instead of judging, for a post Home would skip. photo: X's URL for its
    // first photo, or "". alt: its image descriptions, read now.
    function send(post, home = false, photo = "", alt = post.alt) {
        const { id } = post;
        const epoch = seenEpoch;
        inFlight.add(id);
        browser.runtime
            .sendMessage({ type: "judge", id, home: home && !toldSeen.has(id), trusted: isTrusted(post.handle), post: { author: post.author, handle: post.handle, text: post.text, quoted: post.quoted, alt, photo } })
            .then((res) => {
                const reply = replyOf(res, epoch !== seenEpoch);
                if (reply.seen) seenAt.set(id, Math.max(seenAt.get(id) ?? 0, reply.seen));
                if (reply.told) toldSeen.add(id);
                if (corrected.has(id)) return; // you already decided
                if (reply.answer) answers.set(id, reply.answer);
                else if (reply.coolDown) failedUntil.set(id, reply.until ?? Date.now() + COOL_DOWN_MS);
            })
            .catch(() => failedUntil.set(id, Date.now() + COOL_DOWN_MS))
            .finally(() => {
                inFlight.delete(id);
                schedule();
            });
    }

    // Ahead of you, by aheadAt: the cell's top, and its nearest neighbours' with a height, in X's DOM order.
    function aheadOf(cell) {
        const cells = [...document.querySelectorAll(SEL.cell)];
        const i = cells.indexOf(cell);
        const topOf = (c) => {
            const r = c.getBoundingClientRect();
            return r.height > 0 ? r.top : null;
        };
        let prev = null;
        for (let k = i - 1; k >= 0 && prev === null; k--) prev = topOf(cells[k]);
        let next = null;
        for (let k = i + 1; k < cells.length && next === null; k++) next = topOf(cells[k]);
        return aheadAt(prev, cell.getBoundingClientRect().top, next, headerBottom());
    }

    // Whether Home skips the post in this cell, and whether to ask the background (see skipSeen). The cell's time and
    // place are taken the first time it holds this post; the rest is checked on every rescan, because the
    // background's answer comes later.
    function homeSkip(cell, id, held) {
        if (location.pathname !== "/home") return { skip: false, ask: false };
        let first = cellSeen.get(cell);
        if (first?.id !== id) {
            first = { id, at: Date.now(), ahead: aheadOf(cell) };
            cellSeen.set(cell, first);
        }
        const left = id === leftSeen.id && here() === leftSeen.path;
        const skip = skipSeen({ seenAt: seenAt.get(id), at: first.at, ahead: first.ahead, before: skippedHere.has(id), held, left });
        if (skip) skippedHere.add(id);
        return { skip, ask: first.ahead && !held && !left };
    }

    function cellState(cell, prev) {
        const article = cell.querySelector(SEL.post);
        const afterCollapsed = Boolean(prev) && !tall(prev.sift);
        if (!article) {
            // Control Panel for Twitter's rule: a non-post item right after a collapsed one belongs to it ("Show more replies").
            // Not on a post's page, where such rows (Show probable spam, Show more replies) load replies of their own.
            return noFix(cell, afterCollapsed && !cell.querySelector(SEL.heading) && pathMode(location.pathname) !== "post" ? FOLLOW : OPEN);
        }
        // Ads: X also uses the ad wrapper inside ordinary video players, so only a wrapper around the post counts.
        if (article.closest(SEL.ad)) {
            const v = SiftVerdict.verdict({ ad: true }, settings);
            if (!v.collapsed || peekedAds.has(article)) return noFix(cell, OPEN);
            ensureBar(cell, "", v.label, "", false);
            return noFix(cell, { sift: "collapsed", label: v.label, post: false });
        }
        const post = postOf(article);
        if (!post.id || post.protected) return noFix(cell, OPEN); // never judged, never sent
        // On a post's page: the post itself, the posts above it and its author's replies show as X has them, even an
        // answer under a collapsed reply. A reply joined to one of them follows it, as on timelines.
        if (pathMode(location.pathname) === "post" && !replyJudged(location.pathname, post.id, post.handle, postAuthor())) return noFix(cell, { ...OPEN, post: true });
        // A reply after a Seen bar is a post of its own: it may be new under a post you read before.
        if (post.reply && prev?.post && !prev.seen) {
            if (!inherited.has(post.id)) {
                inherited.add(post.id);
                browser.runtime.sendMessage({ type: "skip", id: post.id, reason: "inherited" }).catch(() => {});
            }
            // A reply follows the post above: hidden with it while it is collapsed, blurred while it waits.
            if (afterCollapsed) return noFix(cell, { ...FOLLOW, post: true });
            return noFix(cell, { sift: prev.sift === "pending" ? "pending" : null, label: null, post: true });
        }
        // An author you always show: open, without Jev. Asked about only for Home's seen check, which the background
        // answers without a call. Your own Hide on one of their posts still counts.
        const known = answers.get(post.id);
        const answer = known?.byYou || !isTrusted(post.handle) ? known : known ? { trusted: true } : undefined;
        const current = cell.getAttribute("data-sift");
        // The post you're on, and the post you left with focus mode on when you come back (X remounts it, and a
        // collapse deferred while you were on it would otherwise apply and move focus mode past it).
        const held = ((focusing ? cell === selected && current !== "pending" : cell.contains(document.activeElement)) || (leftId !== null && post.id === leftId)) && !answer?.byYou;
        const { skip, ask } = homeSkip(cell, post.id, held);
        // A seen post has nothing to teach: no Hide, and no Keep after Show, which would clear Show and collapse it again.
        if (skip) noFix(cell);
        else ensureFix(cell, post.id, peeked.has(post.id), post.handle);
        const verdict = skip ? { collapsed: true, label: seenLabel(seenAt.get(post.id) ?? Date.now(), Date.now()) } : answer ? SiftVerdict.verdict(answer, settings) : null;
        const d = decide({
            verdict,
            current,
            above: Boolean(verdict?.collapsed) && current === "pending" && cell.getBoundingClientRect().top < 0,
            deferred: deferred.get(cell) === post.id,
            inFlight: inFlight.has(post.id),
            coolingDown: (failedUntil.get(post.id) ?? 0) > Date.now(),
            retried: failedUntil.has(post.id),
            waitingOpen: openWaiting.get(cell) === post.id,
            peeked: peeked.has(post.id),
            held,
        });
        if (d.defer) deferred.set(cell, post.id);
        if (!verdict && d.sift === null) openWaiting.set(cell, post.id);
        else openWaiting.delete(cell);
        if (d.send) {
            const photo = photoOf(article, post.id);
            if (photo !== null || photoWaited(article, post.id)) send(post, ask, photo ?? "", altOf(article));
        }
        if (d.sift === "collapsed") ensureBar(cell, post.id, d.label, post.handle, !skip);
        return { sift: d.sift, label: d.label, post: true, seen: skip };
    }

    // Your Keep or Hide, from a button or the h key: remembered in this tab and sent to the background to store and learn.
    function correct(cell, id, wanted) {
        const was = cell.getAttribute("data-sift") === "collapsed" ? "collapsed" : cell.getAttribute("data-sift") === "pending" ? "pending" : "open";
        const prev = answers.get(id) ?? {};
        corrected.add(id);
        peeked.delete(id);
        deferred.delete(cell);
        answers.set(id, { ...prev, byYou: wanted });
        browser.runtime.sendMessage({ type: "label", id, wanted, was, scores: learnableScores(prev) }).catch(() => {});
    }

    // Always show an author: at once in this tab, then saved, which reaches the other tabs. Their posts open, and
    // aren't sent to Jev again.
    function trust(handle) {
        const key = SiftVerdict.handleKey(handle);
        if (!key || trusted.has(key)) return;
        trusted.add(key);
        settings = { ...settings, trusted: [...trusted] };
        browser.storage.local
            .get("trusted")
            .then((raw) => browser.storage.local.set({ trusted: [...SiftVerdict.settingsFrom(raw).trusted, key] }))
            .catch(() => {});
    }

    // Capture phase on document, so X's own handlers never see clicks on Xift's buttons. Page scripts can't fake them.
    function onClick(event) {
        // X ignores clicks with ⌥ held, and you hold ⌥ to see the menu and the right column: click the item without it.
        const item = event.altKey && event.isTrusted && settings.enabled && event.target.closest?.(`:is(${MENU}, ${SIDE}) :is(a, button, [role="link"], [role="button"])`);
        if (item) {
            event.preventDefault();
            event.stopPropagation();
            item.click();
            return;
        }
        // Opening a post counts as reading it: a click on the post itself or on its time link, not on another link, a
        // button, an image, or a quoted post, which go elsewhere.
        if (event.isTrusted && event.button === 0 && pathMode(location.pathname) === "filter") {
            const article = event.target.closest?.(SEL.post);
            const link = event.target.closest?.("a, button, [role='button'], [role='link']");
            const href = link?.matches("a") ? link.getAttribute("href") ?? "" : null;
            const id = article ? idOf(article) : null;
            if (id && (!link || (href !== null && href.endsWith(`/status/${id}`)))) {
                if (remember(article.closest(SEL.cell))) opened = id;
            }
        }
        const button = event.target.closest?.(".sift-bar button, .sift-fix button");
        if (!button || !event.isTrusted) return;
        event.preventDefault();
        event.stopPropagation();
        const holder = button.parentElement;
        const cell = holder.parentElement;
        const id = holder.dataset.siftId;
        if (button.dataset.act === "show") {
            if (id) peeked.add(id);
            else {
                const article = cell.querySelector(SEL.post);
                if (article) peekedAds.add(article);
            }
        } else if (button.dataset.act === "trust") {
            trust(holder.dataset.siftHandle);
        } else if (id) {
            correct(cell, id, button.dataset.act === "keep" ? "show" : "hide");
        }
        schedule();
        if (focusing && cell.matches?.(SEL.cell)) {
            rescan();
            if (button.dataset.act !== "hide") select(cell, headerBottom(), false, true); // Show or Keep, reached with ⌥
        }
    }

    // The bottom edge of X's sticky header over the timeline: the tab bar on /home, the search box on /search. X's
    // #layers (menus, dialogs, hovercards) don't count: an open menu lays a fixed, full-screen layer over the page.
    function headerBottom() {
        const column = document.querySelector('[data-testid="primaryColumn"]')?.getBoundingClientRect();
        if (!column) return 0;
        for (const el of document.elementsFromPoint(column.left + column.width / 2, 1)) {
            if (el.closest("#layers")) continue;
            for (let node = el; node && node !== document.body; node = node.parentElement) {
                const { position } = getComputedStyle(node);
                if (position === "sticky" || position === "fixed") return Math.max(0, node.getBoundingClientRect().bottom);
            }
        }
        return 0;
    }

    const onScreen = (cell, header) => {
        const r = cell.getBoundingClientRect();
        return r.bottom > header && r.top < innerHeight;
    };

    const here = () => location.pathname + location.search;

    const postId = (cell) => {
        const article = cell?.querySelector(SEL.post);
        return article ? idOf(article) : null;
    };

    // Cells as pick and focusPick see them: open posts, bars and the rest, with their place on screen.
    const cellList = (cells) =>
        cells.map((cell) => {
            const r = cell.getBoundingClientRect();
            return { open: Boolean(cell.querySelector(SEL.post)) && tall(cell.getAttribute("data-sift")), top: r.top, bottom: r.bottom };
        });

    function scrollTimeline(top) {
        scrolls++;
        ownScroll = performance.now() + 100;
        window.scrollBy({ top, behavior: "instant" });
    }

    // Focuses a post, so X's own keys (l, r, t, b, Enter) act on it, and with scroll puts its top where X's own j
    // would. X moves cells a frame or two after a collapse above them, so the post is aligned again two frames later.
    // Without scroll (after h) the post stays where it rises, just under the new bar. In focus mode the post is
    // marked current first, because Firefox won't focus a post in a hidden cell, and a scroll holds it in place
    // through X's late moves. quiet: an automatic pick (the wheel, a re-mark, a re-pick, Show or Keep), which shows no
    // focus ring and takes focus only from the page itself or another post. Focus never leaves a text box.
    function select(cell, header, scroll, quiet = false) {
        queueSeen();
        if (focusing) markCurrent(cell);
        selected = cell;
        const active = document.activeElement;
        if (!editable(active) && (!quiet || active === document.body || active?.closest?.(SEL.cell))) {
            cell.querySelector(SEL.post)?.focus({ preventScroll: true, focusVisible: !quiet });
        }
        if (focusing) edges = exitEdges(cell.getBoundingClientRect(), readingLine(header, innerHeight), header);
        if (!scroll) return;
        if (focusing) return hold(cell, null);
        const align = () => {
            const shift = cell.getBoundingClientRect().top - (headerBottom() - 1);
            if (Math.abs(shift) > 1) scrollTimeline(shift);
        };
        align();
        requestAnimationFrame(() => requestAnimationFrame(() => selected === cell && cell.isConnected && align()));
    }

    // Moves the current-post mark. Videos Xift paused play again when their post becomes current.
    function markCurrent(cell) {
        for (const old of document.querySelectorAll("[data-sift-current]")) if (old !== cell) old.removeAttribute("data-sift-current");
        cell.setAttribute("data-sift-current", "");
        for (const video of cell.querySelectorAll("video")) {
            if (!pausedBySift.delete(video)) continue;
            video.play().catch(() => {});
        }
        currentId = postId(cell);
        picked = true;
        pauseHidden();
    }

    // Pauses videos playing in the cells focus mode hides: they are still on screen as far as X knows, so X wouldn't
    // pause them, and an unmuted one would play on unseen. Runs when the mark moves and when the layout comes back.
    function pauseHidden() {
        if (!layout || !document.querySelector("[data-sift-current]")) return;
        for (const video of document.querySelectorAll(`${SEL.cell}:not([data-sift-current]) video`)) {
            if (video.paused) continue;
            video.pause();
            pausedBySift.add(video);
        }
    }

    const markHolds = () => {
        const marked = document.querySelector("[data-sift-current]");
        return Boolean(marked) && (!currentId || postId(marked) === currentId);
    };

    // Keeps a post at a place on screen while X re-measures cells after a switch: re-aligned on each of the next
    // 10 frames, and whenever X restyles something in the timeline in that time (MutationObserver callbacks run before
    // paint, so X's late moves aren't painted). top: where its top goes, or null for just under X's header. frames: how
    // long. Your scrolling or a newer hold stops it.
    function hold(cell, top, frames = 10) {
        const mine = ++realign;
        const align = () => {
            if (mine !== realign || !cell.isConnected) return false;
            const shift = cell.getBoundingClientRect().top - (top ?? headerBottom() - 1);
            if (Math.abs(shift) > 1) scrollTimeline(shift);
            return true;
        };
        const watch = new MutationObserver(align);
        watch.observe(document.querySelector('[data-testid="primaryColumn"]') ?? document.body, { attributes: true, attributeFilter: ["style"], subtree: true });
        const settle = () => {
            if (!focusing || selected !== cell) return;
            const header = headerBottom();
            edges = exitEdges(cell.getBoundingClientRect(), readingLine(header, innerHeight), header);
        };
        let frame = 0;
        const tick = () => {
            if (align() && ++frame < frames) return requestAnimationFrame(tick);
            watch.disconnect();
            if (mine === realign) settle();
        };
        tick();
        settle(); // right after the first align, so a wheel that stops the hold early reads where the post is now
    }

    // The attributes filter.css keys the focus layout off.
    function setLayout(want) {
        layout = want;
        const root = document.documentElement;
        root.toggleAttribute("data-sift-focus", Boolean(want));
        if (want) root.setAttribute("data-sift-width", settings.focusWidth);
        else root.removeAttribute("data-sift-width");
        if (want && settings.focusText !== "x") root.setAttribute("data-sift-text", settings.focusText);
        else root.removeAttribute("data-sift-text");
        pauseHidden();
    }

    // Coming back to the page you left with focus mode on waits up to 1 s for X to mount the post you were on; a timer
    // ends the wait, so a quiet page doesn't wait for X's next change.
    function startFocus() {
        focusing = true;
        picked = false;
        currentId = null;
        if (leftPath !== here()) leftId = null;
        comingBack = leftId ? performance.now() + 1000 : 0;
        if (leftId) setTimeout(schedule, 1000);
    }

    // leaving: you went to another page with focus mode on, so the post you were on is found again when you come back.
    function stopFocus(leaving) {
        leftId = leaving ? currentId : null;
        leftPath = focusHere;
        focusing = false;
        picked = false;
        currentId = null;
        edges = null;
        document.querySelectorAll("[data-sift-current]").forEach((el) => el.removeAttribute("data-sift-current"));
    }

    // Brings the page in line with focus mode: on or off, the layout, and the current post's place on screen. Starting
    // picks a post from what you see before the layout changes, and puts it under the header; every other switch keeps
    // the current post where it is on screen.
    function applyLayout() {
        const mode = pathMode(location.pathname);
        if (mode === "freeze" || document.hidden) return; // under a photo or the compose box; a tab in the background
        const on = settings.enabled && settings.focus && mode === "filter" && innerWidth >= FOCUS_MIN_WIDTH && Boolean(document.querySelector(MENU));
        const want = on && !altBreak ? `${settings.focusWidth}|${settings.focusText}` : "";
        if (on) focusHere = here();
        if (want === layout && on === focusing) return;
        if (on && focusing) followFocus(); // a current post that left the screen (during ⌥'s break) is picked first
        const header = headerBottom();
        // Leaving the page needs nothing kept.
        const keep = focusing && mode === "filter" && selected?.isConnected && onScreen(selected, header) ? selected : null;
        const top = keep?.getBoundingClientRect().top;
        if (on && !focusing) {
            startFocus();
            followFocus(); // pick from what you see now, before the column widens; its hold carries the post through the switch
        }
        if (!on && focusing) stopFocus(mode !== "filter");
        setLayout(want);
        if (keep) hold(keep, top);
        else followFocus();
    }

    // Keeps a current post while focus mode is on, and returns true when it changed it:
    // - Coming back, it marks the post you left as soon as X mounts it, and holds it under the header for 1 s.
    // - With none picked yet (f, the popup, a load), it picks the post you were on if it's at the top, else the one
    //   across the reading line (at the top of the page, the first post), and puts it under the header.
    // - A current post that collapsed (a late verdict while it was blurred, an ad, a reply hidden with its post) gives
    //   way to the next open post, put under the header, as h does.
    // - When X redrew or reused the current post's cell, the mark follows the post.
    // - When the current post has left the screen or X has unmounted it, and no scroll is under way, it picks again
    //   without scrolling: at the top or with the post gone, where j would start; otherwise across the reading line.
    //   With nothing to pick, the mark stays (X's spinner shows).
    function followFocus() {
        if (!focusing) return false;
        const header = headerBottom();
        // The usual case, without scanning every cell: the current post is marked, open and on screen.
        if (picked && !leftId && selected?.isConnected && selected.hasAttribute("data-sift-current") && tall(selected.getAttribute("data-sift"))
            && (!currentId || postId(selected) === currentId) && onScreen(selected, header)) return false;
        const cells = [...document.querySelectorAll(SEL.cell)];
        const holding = (id) => (id ? cells.find((cell) => postId(cell) === id) : undefined);
        if (leftId) {
            const back = holding(leftId);
            if (!back && performance.now() < comingBack) return false;
            leftId = null;
            if (back) {
                // X's own scroll restore drifts for about half a second after you come back (probed), so the post is
                // held under the header for 1 s, and nothing is picked again meanwhile.
                select(back, header, false, true);
                hold(back, null, 60);
                modalUntil = performance.now() + 1000;
                setTimeout(schedule, 1000);
                return true;
            }
        }
        const line = readingLine(header, innerHeight);
        if (!picked) {
            const list = cellList(cells);
            const was = [document.activeElement?.closest?.(SEL.cell), selected].map((cell) => cells.indexOf(cell)).find((i) => i >= 0 && focusPick(list, i, line, header, innerHeight) === i) ?? -1;
            const i = focusPick(list, was, line, header, innerHeight, scrollY < 1);
            if (i >= 0) select(cells[i], header, true, true);
            return i >= 0;
        }
        const current = currentId ? holding(currentId) : selected?.isConnected ? selected : undefined;
        if (current && onScreen(current, header)) {
            if (!tall(current.getAttribute("data-sift"))) {
                const next = cells[pick(cellList(cells), cells.indexOf(current), 1, header)];
                if (next) select(next, header, true, true);
                return Boolean(next);
            }
            if (!current.hasAttribute("data-sift-current")) select(current, header, false, true);
            return false;
        }
        if (scrolling || performance.now() < modalUntil) return false;
        // A mark left on a cell X reused for something else goes, so the feed shows rather than the wrong item.
        for (const el of document.querySelectorAll("[data-sift-current]")) if (el !== current) el.removeAttribute("data-sift-current");
        const i = focusPick(cellList(cells), -1, line, header, innerHeight, !current || scrollY < 1);
        if (i < 0) return false;
        select(cells[i], header, false, true);
        return true;
    }

    // Your scrolling: the scroll events that follow count as reading, and any re-align stops.
    function userInput() {
        inputUntil = performance.now() + 500;
        canStep = true;
        realign++;
    }

    // A scroll is under way until 150 ms after the last scroll event. Reading with the wheel in focus mode: a scroll
    // you made that carries the current post past its edge makes the next open post current, one post per input,
    // without scrolling. This runs before the off-screen check (onSettled), so a short post carried out of the top
    // hands over to the next post, not to the one across the line.
    function onScroll() {
        const dy = scrollY - lastY;
        lastY = scrollY;
        scrolling = true;
        clearTimeout(settleTimer);
        settleTimer = setTimeout(onSettled, 150);
        queueSeen();
        if (!focusing || pathMode(location.pathname) !== "filter") return;
        const now = performance.now();
        if (!dy || !edges || !selected?.isConnected || now < ownScroll || !(dragging || (canStep && now <= inputUntil))) return;
        const step = readOn(selected.getBoundingClientRect(), edges, Math.sign(dy));
        if (!step) return;
        const header = headerBottom();
        const cells = [...document.querySelectorAll(SEL.cell)];
        const next = cells[pick(cellList(cells), cells.indexOf(selected), step, header)];
        if (!next) return;
        canStep = false;
        select(next, header, false, true);
    }

    function onSettled() {
        scrolling = false;
        if (pathMode(location.pathname) === "filter") followFocus();
    }

    const MORE = '[data-testid="tweet-text-show-more-link"]';

    // The Show more of the post you're on, else of the top post on screen that has one. A post's own text comes
    // before a quoted post's, so it is found first. Collapsed posts have no box, so they never count as on screen.
    function showMore() {
        if (focusing) return selected?.querySelector(MORE) ?? null; // the post you're on, never a hidden one
        const header = headerBottom();
        const visible = (el) => {
            const r = el.getBoundingClientRect();
            return r.bottom > header && r.top < innerHeight;
        };
        const current = [document.activeElement?.closest?.(SEL.post), selected?.querySelector(SEL.post)].find((post) => post?.isConnected && visible(post));
        if (current) return current.querySelector(MORE);
        return [...document.querySelectorAll(`[data-testid="primaryColumn"] ${MORE}`)].find(visible) ?? null;
    }

    const editable = (el) => el?.isContentEditable || el?.matches?.("input, textarea, select, [role='textbox'], [role='combobox']");

    // Shows or hides X's menu with its numbers, and the right column. filter.css starts showing them only after ⌥
    // is held 100 ms, so ⌥ shortcuts such as ⌥⌘I don't trigger them.
    function showNav(on) {
        const root = document.documentElement;
        if (on === root.hasAttribute("data-sift-nav")) return;
        if (on) for (const code of Object.keys(NAV_KEYS)) navItem(code)?.setAttribute("data-sift-key", code.slice(-1));
        root.toggleAttribute("data-sift-nav", on);
    }

    function resetNav() {
        navCancelled = false;
        showNav(false);
        endBreak();
    }

    // ⌥ held on its own for 100 ms (the menu's wait) gives X's normal layout back while focus mode stays on. A timer,
    // because CSS can't hold back a width change: without the wait, every ⌥ shortcut would re-wrap the page.
    function startBreak() {
        if (!focusing || altBreak || altTimer) return;
        altTimer = setTimeout(() => {
            altTimer = 0;
            altBreak = true;
            applyLayout();
        }, 100);
    }

    // Focus mode comes back, unless you're typing in the right column, have keyboard focus there, or have a menu open,
    // which would vanish under you. The next key or pointer event without ⌥ tries again (resetNav), so Escape out of
    // the search box brings it back. Focus left on the page or in the now hidden column goes back to the current post.
    function endBreak() {
        clearTimeout(altTimer);
        altTimer = 0;
        const active = document.activeElement;
        if (!altBreak || (active?.closest?.(SIDE) && (editable(active) || active.matches(":focus-visible"))) || document.querySelector('[role="menu"]')) return;
        altBreak = false;
        applyLayout();
        const now = document.activeElement;
        if (selected?.isConnected && (now === document.body || now?.closest?.(SIDE))) selected.querySelector(SEL.post)?.focus({ preventScroll: true });
    }

    // ⌥ alone shows the menu; ⌥ + a number key opens that item. Any other key with ⌥ hides it until ⌥ is
    // released. Never while typing: ⌥ types accents and jumps words there. Returns true when it used the key.
    function onNavKey(event) {
        if (!event.altKey) {
            resetNav();
            return false;
        }
        const allowed = event.isTrusted && settings.enabled && !event.ctrlKey && !event.metaKey && !event.isComposing && !editable(event.target);
        if (event.key === "Alt") {
            if (allowed && !navCancelled) {
                showNav(true);
                startBreak();
            }
            return false;
        }
        // An open menu or dialog, such as a draft in the compose box, keeps the keyboard.
        if (!NAV_KEYS[event.code] || !allowed || document.querySelector('[role="menu"], [aria-modal="true"]')) {
            navCancelled = true;
            showNav(false);
            endBreak();
            return false;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        clearTimeout(altTimer); // a number pressed before the wait ends: no layout switch
        altTimer = 0;
        if (!event.repeat) navItem(event.code)?.click();
        return true;
    }

    // 1–9 pick the nth tab of the page's tab row: Home's For you and Following, search's Top and Latest, and so
    // on. The row in X's page header only: profiles have another inside the timeline. Matched by key position
    // (event.code), so AZERTY works, Shift allowed. Returns true when it used the key.
    function onTabKey(event, plain) {
        if (!/^Digit[1-9]$/.test(event.code) || !plain) return false;
        if (!event.isTrusted || event.defaultPrevented || event.isComposing || editable(event.target) || !settings.enabled) return false;
        if (event.target.closest?.('[data-testid="videoPlayer"]') || document.querySelector('[role="menu"], [aria-modal="true"]')) return false;
        const row = document.querySelector('[data-testid="primaryColumn"] nav [role="tablist"]');
        if (!row) return false; // no tabs here, such as a single post: the key is X's
        // Every digit is used here, held or without a tab, so none reaches Firefox: on AZERTY, 4 types ' (Quick Find).
        event.preventDefault();
        event.stopImmediatePropagation();
        const tab = [...row.querySelectorAll('[role="tab"]')].filter((t) => t.getClientRects().length)[event.code.slice(-1) - 1];
        // Clicking the tab you're on would make X scroll to the top and reload For you.
        if (tab && !event.repeat && tab.getAttribute("aria-selected") !== "true") tab.click();
        return true;
    }

    // ⌫ clicks X's back arrow (posts, search, profiles, lists) and e clicks Show more, on any X page. Returns true
    // when it used the key; without an arrow or a Show more, the key is left alone.
    function onPageKey(event, key, plain) {
        if ((key !== "Backspace" && key !== "e") || !plain || event.shiftKey) return false;
        if (!event.isTrusted || event.defaultPrevented || event.isComposing || editable(event.target) || !settings.enabled) return false;
        if (event.target.closest?.('[data-testid="videoPlayer"]') || document.querySelector('[role="menu"], [aria-modal="true"]')) return false;
        const target = key === "e" ? showMore() : document.querySelector('[data-testid="primaryColumn"] [data-testid="app-bar-back"]');
        if (!target) return false;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) target.click();
        return true;
    }

    let repostOpener = null; // the Repost button t last clicked, for focus to go back to
    // X's Repost menu (Repost, Quote), when it's open.
    const REPOST_MENU = '[role="menu"]:has([data-testid="retweetConfirm"], [data-testid="unretweetConfirm"])';

    // t opens X's Repost menu on the post you're on, and closes it when it's open: X's own t only opens it, and in full
    // screen Firefox takes the first Escape to leave full screen. Returns true when it used the key; with no post to act
    // on, or another menu or dialog open, the key is X's.
    function onRepostKey(event, key, plain) {
        if (key !== "t" || !plain || event.shiftKey) return false;
        if (!event.isTrusted || event.defaultPrevented || event.isComposing || editable(event.target) || !settings.enabled) return false;
        const menu = document.querySelector(REPOST_MENU);
        let button = null;
        if (!menu) {
            if (event.target.closest?.('[data-testid="videoPlayer"]') || document.querySelector('[role="menu"], [aria-modal="true"]')) return false;
            const article = focusing && selected?.isConnected ? selected.querySelector(SEL.post) : document.activeElement?.closest?.(SEL.post);
            button = article?.querySelector('[data-testid="retweet"], [data-testid="unretweet"]');
            if (!button) return false;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat) return true;
        if (!menu) {
            repostOpener = button;
            button.click();
            return true;
        }
        // X ignores an Escape a script sends, so t clicks outside the menu, as you would: X's full-screen layer under
        // it, at the window's top-left corner, which the menu never covers. Focus goes back to the button, as on Escape.
        const outside = document.elementsFromPoint(1, 1).find((el) => el.closest("#layers") && !el.closest('[role="menu"]'));
        const opener = document.querySelector('[data-testid="retweet"][aria-expanded="true"], [data-testid="unretweet"][aria-expanded="true"]') ?? repostOpener;
        outside?.click();
        if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body || document.activeElement.closest("#layers"))) opener.focus({ preventScroll: true });
        return true;
    }

    // f turns focus mode on or off on the pages Xift filters: at once in this tab, then saved for every tab. Returns
    // true when it used the key.
    function onFocusKey(event, key, plain) {
        if (key !== "f" || !plain || event.shiftKey || event.repeat) return false;
        if (!event.isTrusted || event.defaultPrevented || event.isComposing || editable(event.target) || !settings.enabled) return false;
        if (pathMode(location.pathname) !== "filter" || innerWidth < FOCUS_MIN_WIDTH || !document.querySelector(MENU)) return false;
        if (event.target.closest?.('[data-testid="videoPlayer"]') || document.querySelector('[role="menu"], [aria-modal="true"]')) return false;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (scheduled) rescan(); // the marks first, so a first pick sees bars and ads as they are
        leftId = null;
        settings = { ...settings, focus: !settings.focus };
        applyLayout();
        browser.storage.local.set({ focus: settings.focus }).catch(() => {});
        return true;
    }

    // A click in focus mode's wide empty margin drops focus to the page, and X's keys then do nothing: put it back on
    // the current post. Focus that moves anywhere else (a text box, a menu, a link) is left alone.
    function onFocusOut(event) {
        if (!focusing || !selected?.contains(event.target)) return;
        setTimeout(() => {
            if (focusing && document.activeElement === document.body && selected?.isConnected) selected.querySelector(SEL.post)?.focus({ preventScroll: true });
        });
    }

    // In focus mode, a video in a hidden cell that starts playing is paused: X autoplays what it thinks is on screen.
    function onPlay(event) {
        const video = event.target;
        if (!layout || !document.querySelector("[data-sift-current]") || !video.closest?.(SEL.cell) || video.closest("[data-sift-current]")) return;
        video.pause();
        pausedBySift.add(video);
    }

    // j and k move between open posts, skipping bars; h hides the post you're on. Everything else is X's.
    // Capture phase on window, so X's own j and k never run: they get stuck on a collapsed post.
    function onKey(event) {
        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key; // Caps Lock gives "J"
        if (event.isTrusted && SCROLL_KEYS.has(event.key) && !editable(event.target)) userInput();
        const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
        const chord = afterChord;
        afterChord = plain && (key === "g" || key === "a") && !editable(event.target);
        // Opening a post with Enter counts as reading it. X opens it; Xift only records it.
        if (key === "Enter" && plain && !event.shiftKey && event.isTrusted && event.target.matches?.(SEL.post) && pathMode(location.pathname) === "filter") {
            const cell = event.target.closest(SEL.cell);
            if (remember(cell)) opened = idOf(event.target);
        }
        if (onNavKey(event) || onTabKey(event, plain && !chord) || onPageKey(event, key, plain && !chord) || onRepostKey(event, key, plain && !chord) || onFocusKey(event, key, plain && !chord)) return;
        // X keeps its search box focused on Escape. Xift hides the right column, so Escape leaves the column instead.
        if (key === "Escape" && event.isTrusted && settings.enabled && event.target.closest?.(SIDE)) {
            event.target.blur();
            return;
        }
        if (!["j", "k", "h"].includes(key) || chord || !plain || event.shiftKey) return;
        if (!event.isTrusted || event.defaultPrevented || event.isComposing || editable(event.target)) return;
        if (!["filter", "post"].includes(pathMode(location.pathname)) || !settings.enabled) return;
        // A focused video takes k for pause; an open menu or dialog takes the keyboard.
        if (event.target.closest?.('[data-testid="videoPlayer"]') || document.querySelector('[role="menu"], [aria-modal="true"]')) return;
        if (scheduled) rescan(); // mark the cells X mounted since the last frame
        const cells = [...document.querySelectorAll(SEL.cell)];
        if (!cells.some((cell) => cell.querySelector(SEL.post))) return; // no posts here, such as People search
        event.preventDefault();
        event.stopImmediatePropagation();
        const header = headerBottom();
        const focused = document.activeElement?.closest?.(SEL.cell);
        // After Space or the mouse wheel, the post you were on is off screen: start from what's on screen instead.
        const current = focusing && cells.includes(selected) ? selected : ([focused, selected].find((cell) => cell && cells.includes(cell) && onScreen(cell, header)) ?? null);
        const list = () => cellList(cells);
        if (key === "h") {
            // Only where the hide button is: an open post Xift judged, never an ad, a reply that follows, or a waiting post.
            const fix = current?.querySelector(":scope > .sift-fix");
            const article = current?.querySelector(SEL.post);
            if (event.repeat || !fix || current.hasAttribute("data-sift") || !article || idOf(article) !== fix.dataset.siftId) return;
            correct(current, fix.dataset.siftId, "hide");
            rescan(); // collapse it now: the next post rises under its bar
            const next = cells[pick(list(), cells.indexOf(current), 1, header)];
            if (next) select(next, header, focusing); // in focus mode its bar is hidden anyway: the next post goes to the top
            else selected = null;
            return;
        }
        const dir = key === "j" ? 1 : -1;
        const next = cells[pick(list(), cells.indexOf(current), dir, header)];
        if (next) {
            if (jRecords(dir, event.repeat, Boolean(current))) remember(current); // the post j leaves counts as seen
            scrolledFor = null;
            select(next, header, true);
            return;
        }
        // No open post loaded that way: scroll a screen so X loads more, then wait for it. A held key would
        // otherwise scroll on past posts X hadn't mounted yet.
        const posts = cells.filter((cell) => cell.querySelector(SEL.post));
        const edge = dir > 0 ? posts.at(-1) : posts[0];
        if (edge === scrolledFor) return;
        scrolledFor = edge;
        scrollTimeline(dir * (innerHeight - header));
    }

    // Styles every timeline cell from stored state, changing only what is wrong. Runs before paint.
    function rescan() {
        scheduled = false;
        const mode = pathMode(location.pathname);
        if (lastMode === "freeze" && mode !== "freeze") {
            modalUntil = performance.now() + 1000;
            setTimeout(schedule, 1000);
        }
        // Leaving a filter page: the post you were on, or opened, is never skipped when you come back.
        if (lastMode === "filter" && (mode === "off" || mode === "post")) {
            leftSeen = { id: focusing ? currentId : opened, path: lastFilterPath };
            opened = null;
        }
        if (mode === "filter") lastFilterPath = here();
        lastMode = mode;
        if (mode === "freeze") return;
        if (mode === "off" || (mode === "post" && !settings.judgeReplies) || !settings.enabled) {
            applyLayout();
            queueSeen(); // leaving resets the counters
            return stripAll();
        }
        const changes = [];
        let prev = null;
        for (const cell of document.querySelectorAll(SEL.cell)) {
            const want = cellState(cell, prev);
            if (want.sift !== cell.getAttribute("data-sift") || want.label !== cell.getAttribute("data-sift-label")) changes.push({ cell, ...want });
            prev = want;
        }
        apply(changes);
        applyLayout();
        followFocus();
        queueSeen();
    }

    function schedule() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(rescan);
    }

    // Every setting except the key, which only the background uses. Verdicts are recomputed; Jev isn't asked again.
    function onSettings(changes, area) {
        if (area !== "local") return;
        if ("seenCleared" in changes) {
            // The Seen list was cleared: forget what this tab knew, so its Seen bars open on the next rescan.
            seenEpoch++;
            seenAt.clear();
            skippedHere.clear();
            toldSeen.clear();
            cellSeen = new WeakMap();
            schedule();
        }
        if ("dailyLimit" in changes || "spendReset" in changes) {
            // Posts paused by the spending limit are asked about again after a new limit or a reset, still open (see
            // decide's retried).
            for (const id of failedUntil.keys()) failedUntil.set(id, 0);
            schedule();
        }
        if (!SETTING_KEYS.some((key) => key in changes)) return;
        if ("focus" in changes || "enabled" in changes) leftId = null; // a later start shouldn't wait for an old post
        browser.storage.local.get(SETTING_KEYS).then((raw) => {
            // This tab's focus stays unless the change is to focus: f's own save may still be under way.
            if (!("focus" in changes)) raw.focus = settings.focus;
            settings = SiftVerdict.settingsFrom(raw);
            trusted = new Set(settings.trusted);
            // Authors you no longer always show are judged again: their answers were only "always shown".
            if ("trusted" in changes) for (const [id, answer] of answers) if (answer.trusted) answers.delete(id);
            // Another model scores on another scale: its posts are asked about again, rather than the old scores meeting
            // the new model's thresholds (and teaching them on Keep or Hide). Your own corrections stay.
            if ("provider" in changes || "localModel" in changes) for (const [id, answer] of answers) if (answer.scores && !answer.byYou) answers.delete(id);
            applyOnOff();
            schedule();
        });
    }

    // filter.css hides X's menu and right column unless this is set, so it doesn't flash on every page load.
    function applyOnOff() {
        document.documentElement.toggleAttribute("data-sift-off", !settings.enabled);
        if (!settings.enabled) resetNav();
    }

    function start() {
        // Anything a previous version of Xift left on this page.
        document.querySelectorAll(".sift-fix, .sift-bar").forEach((el) => el.remove());
        document.querySelectorAll("[data-sift]").forEach((el) => setMark(el, null, null));
        document.documentElement.removeAttribute("data-sift-reveal");
        document.documentElement.removeAttribute("data-sift-nav");
        for (const name of ["data-sift-focus", "data-sift-width", "data-sift-text"]) document.documentElement.removeAttribute(name);
        document.querySelectorAll("[data-sift-current]").forEach((el) => el.removeAttribute("data-sift-current"));
        document.querySelectorAll("[data-sift-key]").forEach((el) => el.removeAttribute("data-sift-key"));
        document.addEventListener("click", onClick, true);
        document.addEventListener("focusout", onFocusOut, true);
        document.addEventListener("play", onPlay, true); // media events don't bubble; capture sees them
        // Focus mode counts the current post only once you've touched the page, so a post picked at load, on a page
        // you leave at once, isn't recorded. Added before onKey, which stops j, k, h and f from reaching later listeners.
        for (const type of ["keydown", "pointerdown", "wheel"]) {
            window.addEventListener(type, (event) => {
                if (!event.isTrusted || hadInput) return;
                hadInput = true;
                queueSeen();
            }, { capture: true, passive: true });
        }
        window.addEventListener("keydown", onKey, true);
        // A ⌥ release can be missed (⌘-Tab, devtools): any key or pointer event without ⌥ hides the menu.
        for (const type of ["keyup", "pointermove", "pointerdown"]) window.addEventListener(type, (event) => event.altKey || resetNav(), true);
        window.addEventListener("blur", resetNav);
        document.addEventListener("visibilitychange", () => {
            resetNav();
            applyLayout(); // a change made while this tab was in the background
            checkSeen();
        });
        window.addEventListener("resize", () => applyLayout());
        lastY = scrollY;
        window.addEventListener("wheel", (event) => {
            // Not ⌃-wheel zoom, nor a sideways swipe.
            if (event.isTrusted && !event.ctrlKey && Math.abs(event.deltaY) >= Math.abs(event.deltaX)) userInput();
        }, { capture: true, passive: true });
        // The page's scrollbar (past its content width) or middle-click autoscroll. Overlay scrollbars on macOS never
        // match; the off-screen check covers them.
        window.addEventListener("pointerdown", (event) => {
            if (!event.isTrusted || (event.button !== 1 && event.clientX < document.documentElement.clientWidth)) return;
            dragging = true;
            userInput();
        }, true);
        const stopDragging = () => {
            if (!dragging) return;
            dragging = false;
            userInput();
        };
        window.addEventListener("pointerup", stopDragging, true);
        window.addEventListener("pointercancel", stopDragging, true);
        window.addEventListener("pointermove", (event) => event.buttons || stopDragging(), true);
        window.addEventListener("blur", stopDragging);
        window.addEventListener("scroll", onScroll, { passive: true });
        browser.storage.onChanged.addListener(onSettings);
        browser.storage.local.get(SETTING_KEYS).then((raw) => {
            settings = SiftVerdict.settingsFrom(raw);
            trusted = new Set(settings.trusted);
            applyOnOff();
            new MutationObserver(() => {
                // The mark follows its post before the page is painted: X reuses cells, and a lost mark shows the feed.
                if (focusing && picked && pathMode(location.pathname) === "filter" && !markHolds()) followFocus();
                schedule();
            }).observe(document.body, { childList: true, subtree: true });
            schedule();
        });
    }

    start();
})();
