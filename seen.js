// The Seen list: the posts you've read on X, newest first, drawn as X draws them, with search.
// A classic script after db.js. The Node tests require() it for its pure helpers; the page part runs only in Firefox.
(() => {
    const wordsOf = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
    // Everything search looks in: the text, image descriptions, names and handles, of the post and its quoted post.
    const haystack = (r) => [r.text, r.alt, r.name, `@${r.handle}`, r.quoted?.text, r.quoted?.alt, r.quoted?.name, r.quoted && `@${r.quoted.handle}`].filter(Boolean).join(" ").toLowerCase();
    const matches = (hay, words) => words.every((w) => hay.includes(w));

    // X's short dates: 42m, 5h, Oct 13, Oct 13, 2025.
    function postedLabel(t, now) {
        if (!Number.isFinite(t)) return "";
        const ago = now - t;
        if (ago < 3_600_000) return `${Math.max(1, Math.floor(ago / 60_000))}m`;
        if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)}h`;
        const d = new Date(t);
        return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" });
    }

    function dayLabel(t, now) {
        const d = new Date(t);
        const today = new Date(now);
        const yesterday = new Date(now);
        yesterday.setDate(today.getDate() - 1);
        if (d.toDateString() === today.toDateString()) return "Seen today";
        if (d.toDateString() === yesterday.toDateString()) return "Seen yesterday";
        return `Seen ${d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" })}`;
    }

    if (typeof module !== "undefined") {
        module.exports = { wordsOf, haystack, matches, postedLabel, dayLabel };
        return;
    }

    const BATCH = 2000; // records read at a time
    const PAGE = 200; // posts built at a time as you scroll
    const BADGE = "M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z";
    const BADGE_COLOUR = { blue: "#1d9bf0", gold: "#e2b719", grey: "#829aab" };
    // Mentions, hashtags and links, drawn in X's blue as text: never links.
    const LINKY = /(@\w{1,15}|#\w+|(?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+\/\S*)/;
    const $ = (id) => document.getElementById(id);
    const el = (tag, cls, ...kids) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        e.append(...kids);
        return e;
    };

    let all = []; // records, newest first, each with its haystack
    let shown = []; // what the search lets through
    let built = 0;
    let words = [];
    let lastDay = "";
    let fresh = 0; // new posts waiting behind the "Show new posts" button
    let searchFrame = 0;

    const withHay = (r) => ({ ...r, hay: haystack(r) });

    // Appends text with each searched word marked.
    function marked(target, text) {
        const lower = text.toLowerCase();
        let i = 0;
        while (words.length && i < text.length) {
            let at = -1;
            let len = 0;
            for (const w of words) {
                const j = lower.indexOf(w, i);
                if (j >= 0 && (at < 0 || j < at)) [at, len] = [j, w.length];
            }
            if (at < 0) break;
            target.append(text.slice(i, at), el("mark", "", text.slice(at, at + len)));
            i = at + len;
        }
        target.append(text.slice(i));
        return target;
    }

    function postText(text) {
        const out = el("div", "text");
        text.split(LINKY).forEach((part, i) => marked(i % 2 ? out.appendChild(el("span", "link")) : out, part));
        return out;
    }

    function image(src) {
        const img = el("img");
        img.loading = "lazy";
        img.alt = "";
        img.src = src;
        return img;
    }

    function avatar(r, size = "") {
        const box = el("div", `avatar${size}${r.badge === "gold" ? " org" : ""}`);
        if (r.avatar) box.append(image(r.avatar));
        return box;
    }

    function badge(kind) {
        if (!Object.hasOwn(BADGE_COLOUR, kind)) return "";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("class", "badge");
        svg.setAttribute("aria-label", "Verified");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("fill", BADGE_COLOUR[kind]);
        path.setAttribute("d", BADGE);
        svg.append(path);
        return svg;
    }

    function media(list) {
        if (!list?.length) return "";
        const box = el("div", `media n${list.length}`);
        if (list.length === 1) box.style.setProperty("--r", String(list[0].ratio)); // a single image keeps its shape
        for (const m of list) {
            const tile = el("div", "", image(m.src));
            if (m.kind === "video" || m.kind === "gif") tile.append(el("div", "play"));
            if (m.label) tile.append(el("span", "tag", m.label));
            box.append(tile);
        }
        return box;
    }

    function head(r, cls, extra = "") {
        return el("div", cls, marked(el("span", "name"), r.name), badge(r.badge), marked(el("span", "handle"), `@${r.handle}`), el("span", "date", r.postedAt ? `· ${postedLabel(r.postedAt, Date.now())}` : ""), extra);
    }

    // A quoted post: its small avatar leads its line, as on X.
    function quote(q) {
        if (!q) return "";
        const line = head(q, "qhead");
        line.prepend(avatar(q, " small"));
        return el("div", "quote", line, postText(q.text), media(q.media));
    }

    function row(r) {
        const a = el("a", "post");
        a.href = `https://x.com/i/status/${r.id}`;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        const seen = el("span", "seen", new Date(r.seenAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
        seen.title = "When you saw it";
        a.append(avatar(r), el("div", "body", head(r, "head", seen), postText(r.text), media(r.media), quote(r.quoted)));
        return a;
    }

    function more() {
        const frag = document.createDocumentFragment();
        const now = Date.now();
        for (const r of shown.slice(built, built + PAGE)) {
            const day = new Date(r.seenAt).toDateString();
            if (day !== lastDay) {
                frag.append(el("h2", "", dayLabel(r.seenAt, now)));
                lastDay = day;
            }
            frag.append(row(r));
        }
        built = Math.min(built + PAGE, shown.length);
        $("list").append(frag);
    }

    function render() {
        words = wordsOf($("q").value);
        shown = words.length ? all.filter((r) => matches(r.hay, words)) : all;
        $("list").replaceChildren();
        built = 0;
        lastDay = "";
        fresh = 0;
        $("fresh").hidden = true;
        more();
        showCount();
    }

    function showCount() {
        const total = all.length.toLocaleString("en-US");
        $("count").textContent = words.length ? `${shown.length.toLocaleString("en-US")} of ${total} posts` : `${total} posts`;
        $("empty").hidden = shown.length > 0;
        $("empty").textContent = all.length ? "No seen posts match." : "No seen posts yet. Posts you read on X appear here.";
    }

    // Reads everything, newest first, a batch at a time. The first rows show as soon as the first batch is in; later
    // batches extend the list you scroll (shown is all while there's no search) without rebuilding it under you.
    async function load() {
        all = [];
        const ids = new Set();
        let before = Infinity;
        for (let first = true; ; first = false) {
            const batch = await SiftDB.seenBatch(before, BATCH);
            for (const r of batch) {
                if (ids.has(r.id)) continue;
                ids.add(r.id);
                all.push(withHay(r));
            }
            if (first || words.length) render();
            else showCount();
            if (batch.length < BATCH) return;
            before = batch.at(-1).seenAt;
        }
    }

    // Back on this tab: only the posts seen since, merged by ID. At the top they show; further down, a button does.
    async function refresh() {
        if (document.hidden) return;
        const newer = (await SiftDB.seenSince(all[0]?.seenAt ?? 0)).reverse().map(withHay);
        if (newer.length) {
            const ids = new Set(newer.map((r) => r.id));
            all = [...newer, ...all.filter((r) => !ids.has(r.id))];
        }
        if ((await SiftDB.countSeen()) < all.length) return load(); // cleared, or the limit went down
        if (!newer.length) return;
        if (scrollY < 50) return render();
        fresh += newer.length;
        $("fresh").textContent = `Show ${fresh.toLocaleString("en-US")} new post${fresh === 1 ? "" : "s"}`;
        $("fresh").hidden = false;
    }

    $("q").addEventListener("input", () => {
        cancelAnimationFrame(searchFrame);
        searchFrame = requestAnimationFrame(render); // at most one search per frame
    });
    $("fresh").addEventListener("click", () => {
        render();
        scrollTo(0, 0);
    });
    // The first entry can be measured on the empty page and arrive after the first rows: check where the end is now.
    new IntersectionObserver(() => built < shown.length && $("more").getBoundingClientRect().top < innerHeight + 1200 && more(), { rootMargin: "1200px" }).observe($("more"));
    document.addEventListener("visibilitychange", () => refresh().catch((err) => console.error("Xift: Seen list refresh failed", err)));

    let armed = 0;
    $("clear").addEventListener("click", async () => {
        if (!armed) {
            $("clear").textContent = "Click again to clear";
            armed = setTimeout(() => {
                armed = 0;
                $("clear").textContent = "Clear Seen list";
            }, 3000);
            return;
        }
        clearTimeout(armed);
        armed = 0;
        $("clear").textContent = "Clear Seen list";
        await SiftDB.clearSeen();
        await browser.storage.local.set({ seenCleared: Date.now() }); // open X tabs forget their Seen bars
        await load();
    });

    load().catch((err) => {
        $("empty").hidden = false;
        $("empty").textContent = `The Seen list couldn't be read: ${err}`;
    });
})();
