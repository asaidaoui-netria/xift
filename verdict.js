// Xift's verdict rule: which posts collapse, why, and how your keep and hide clicks move the thresholds.
// A classic script: the background, the content script and the popup load it, and the Node tests require() it.
(() => {
    const QUALITIES = [
        { key: "bait", name: "Engagement bait" },
        { key: "rage", name: "Rage bait" },
        { key: "low", name: "Low substance" },
        { key: "promo", name: "Self-promotion" },
    ];
    // From the 2026-10-14 calibration run (32 invented posts). Your clicks move them from here.
    const DEFAULT_THRESHOLDS = { bait: 0.8, rage: 0.8, low: 0.9, promo: 0.85 };
    const LEARN = { STEP: 0.02, NEAR: 0.3, MIN: 0.05, MAX: 0.99 };
    // The Ollama model when you pick Local: on a 16 GB M4, nimble judged best but took 3 s a post, tev1:4b 1.3 s and
    // tev1:0.8b 0.23 s (2026-10-19). Where local models' thresholds start, since each scores on its own scale: halfway
    // between Jev's defaults and what separated 16 invented posts (11 noisy, 5 clean), never below 0.5.
    // ponytail: invented posts; refit from real judged posts once an Export carries their text.
    const LOCAL_MODEL = "tev1:4b";
    const LOCAL_THRESHOLDS = {
        "tev1:0.8b": { bait: 0.65, rage: 0.74, low: 0.7, promo: 0.68 },
        "tev1:4b": { bait: 0.67, rage: 0.65, low: 0.7, promo: 0.68 },
        nimble: { bait: 0.65, rage: 0.65, low: 0.7, promo: 0.68 },
    };
    const MODEL_NAME = /^[\w.:/-]{1,100}$/;
    const cleanModel = (m) => (typeof m === "string" && MODEL_NAME.test(m) ? m : LOCAL_MODEL);
    // A model's starting thresholds: Jev's for Jev (null) and for local models without figures of their own.
    const defaultThresholds = (local) => ({ ...((local && LOCAL_THRESHOLDS[local.replace(/:latest$/, "")]) || DEFAULT_THRESHOLDS) });
    function cleanThresholds(raw, defaults) {
        const out = {};
        for (const { key } of QUALITIES) {
            const t = raw?.[key];
            out[key] = typeof t === "number" && t >= LEARN.MIN && t <= LEARN.MAX ? t : defaults[key];
        }
        return out;
    }
    const MIN_WORDS = 5;
    const OPEN = { collapsed: false, label: "" };

    // Words start with a letter or digit, in any script, and may carry marks such as Arabic vowels. Emoji don't count.
    const wordCount = (text) => (String(text ?? "").match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? []).length;
    const round2 = (x) => Math.round(x * 100) / 100;
    const isProb = (p) => typeof p === "number" && p >= 0 && p <= 1;

    function cleanScores(raw) {
        const out = {};
        for (const { key } of QUALITIES) {
            if (!isProb(raw?.[key])) return null;
            out[key] = raw[key];
        }
        return out;
    }

    // Focus mode's choices, as the popup stores them.
    const FOCUS_WIDTHS = ["760", "900", "fill"];
    const FOCUS_TEXTS = ["x", "17", "19"];
    // Seen posts: how many the Seen list remembers.
    const SEEN_LIMIT = { MIN: 100, MAX: 100_000, DEFAULT: 10_000 };
    // Which saves also trim the Seen list to the limit: the first after the background wakes (Firefox unloads it
    // when idle, which resets the count), then every 100th.
    const seenTrimDue = (saves) => saves % 100 === 1;
    // How long Jev's scores for a post are reused instead of asking again.
    const SCORES_MS = 7 * 86_400_000;
    // What a call is counted as when OpenRouter reports no cost: a typical text call, rounded up.
    const COST_GUESS = 0.00003;
    // The spending limit until you set your own, in dollars a month.
    const SPEND_LIMIT_DEFAULT = 1;

    // An author you always show, as stored: the handle without @, lowercase, or null for anything else.
    function handleKey(h) {
        const key = typeof h === "string" ? h.replace(/^@/, "").toLowerCase() : "";
        return /^\w{1,15}$/.test(key) ? key : null;
    }
    const TRUSTED_MAX = 1000;

    function settingsFrom(raw = {}) {
        const local = raw.provider === "local" ? cleanModel(raw.localModel) : null;
        const thresholds = cleanThresholds(raw.thresholds, defaultThresholds(local));
        return {
            enabled: raw.enabled !== false,
            collapseAds: raw.collapseAds !== false,
            collapseLittleText: raw.collapseLittleText !== false,
            judgeReplies: raw.judgeReplies !== false,
            thresholds,
            focus: raw.focus === true,
            focusWidth: FOCUS_WIDTHS.includes(raw.focusWidth) ? raw.focusWidth : "900",
            focusText: FOCUS_TEXTS.includes(raw.focusText) ? raw.focusText : "17",
            seenLimit: Number.isFinite(raw.seenLimit) ? Math.min(SEEN_LIMIT.MAX, Math.max(SEEN_LIMIT.MIN, Math.round(raw.seenLimit))) : SEEN_LIMIT.DEFAULT,
            // The spending limit, in dollars a month (see runningTotal), or null for none (stored as 0). Named when it was
            // per day.
            dailyLimit: Number.isFinite(raw.dailyLimit) ? (raw.dailyLimit > 0 ? raw.dailyLimit : null) : SPEND_LIMIT_DEFAULT,
            trusted: Array.isArray(raw.trusted) ? [...new Set(raw.trusted.map(handleKey).filter(Boolean))].slice(0, TRUSTED_MAX) : [],
            local, // the Ollama model that judges, or null for Jev through OpenRouter
            localModel: cleanModel(raw.localModel), // the model Local uses, kept while Jev judges
        };
    }

    // The storage changes for picking a model: the thresholds learnt for the current one are kept, and the next one's
    // come back, its defaults the first time. next: { provider, localModel }.
    function switchModel(raw, next) {
        const scorer = (s) => (s.local ? `local:${s.local}` : "jev");
        const now = settingsFrom(raw);
        const then = settingsFrom({ ...raw, ...next });
        const savedThresholds = { ...raw.savedThresholds, [scorer(now)]: now.thresholds };
        return { provider: next.provider, localModel: next.localModel, thresholds: cleanThresholds(savedThresholds[scorer(then)], defaultThresholds(then.local)), savedThresholds };
    }

    function verdict(answer, settings) {
        if (answer.byYou) return answer.byYou === "hide" ? { collapsed: true, label: "Hidden by you" } : OPEN;
        if (answer.trusted) return OPEN; // an author you always show
        if (answer.ad) return settings.collapseAds ? { collapsed: true, label: "Ad" } : OPEN;
        if (answer.tooLittle) return settings.collapseLittleText ? { collapsed: true, label: "Too little text" } : OPEN;
        let top = null;
        for (const quality of QUALITIES) {
            const p = answer.scores[quality.key];
            const over = p - settings.thresholds[quality.key];
            if (over >= 0 && (!top || over > top.over)) top = { quality, p, over };
        }
        return top ? { collapsed: true, label: `${top.quality.name} ${top.p.toFixed(2)}` } : OPEN;
    }

    // Keep on a collapsed post eases each threshold it crossed; hide on an open post tightens the closest one,
    // if it was within reach. One small step per click, so no single click swings the feed.
    // A copy of the thresholds to move, kept within MIN and MAX, with each real change recorded.
    function stepper(thresholds) {
        const next = { ...thresholds };
        const changes = [];
        const move = (key, to) => {
            const clamped = round2(Math.min(LEARN.MAX, Math.max(LEARN.MIN, to)));
            if (clamped === next[key]) return;
            changes.push({ key, from: next[key], to: clamped });
            next[key] = clamped;
        };
        return { next, changes, move };
    }

    function learn(thresholds, scores, wanted) {
        const { next, changes, move } = stepper(thresholds);
        const crossed = QUALITIES.filter(({ key }) => scores[key] >= thresholds[key]);
        if (wanted === "show") {
            crossed.forEach(({ key }) => move(key, thresholds[key] + LEARN.STEP));
        } else if (wanted === "hide" && crossed.length === 0) {
            const closest = QUALITIES.map(({ key }) => ({ key, gap: thresholds[key] - scores[key] })).sort((a, b) => a.gap - b.gap)[0];
            if (closest.gap <= LEARN.NEAR) move(closest.key, thresholds[closest.key] - LEARN.STEP);
        }
        return { thresholds: next, changes };
    }

    // What one keep or hide does to the thresholds. before: your earlier correction of this post, { wanted, steps }.
    // Keep on a post you hid takes back the steps that hide made, by the same amounts. Otherwise Jev's scores,
    // if sent, teach one step. steps: what to store with this correction, so a later keep can take it back.
    function learnFrom(thresholds, before, scores, wanted) {
        if (wanted === "show" && before?.wanted === "hide") {
            const { next, changes, move } = stepper(thresholds);
            for (const { key, from, to } of before.steps ?? []) if (key in next && Number.isFinite(from - to)) move(key, next[key] + from - to);
            return { thresholds: next, changes, cause: "undo", steps: [] };
        }
        const step = scores ? learn(thresholds, scores, wanted) : { thresholds, changes: [] };
        return { ...step, cause: wanted === "show" ? "keep" : "hide", steps: wanted === "hide" ? step.changes : [] };
    }

    // A seen post as the background stores it: built from the known fields only, or null without a post ID and handle.
    // Strings are cut, image URLs must be X's own image hosts (the Seen list uses them only as img.src), and seenAt is
    // the background's clock, never the sender's.
    const IMAGE_HOSTS = ["https://pbs.twimg.com/", "https://abs.twimg.com/"];
    const BADGES = ["blue", "gold", "grey"];
    const KINDS = ["photo", "video", "gif"];
    const isHandle = (h) => typeof h === "string" && /^\w{1,15}$/.test(h);
    const cut = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
    const image = (v) => (typeof v === "string" && v.length <= 2048 && IMAGE_HOSTS.some((host) => v.startsWith(host)) ? v : "");

    function cleanMedia(list) {
        if (!Array.isArray(list)) return [];
        return list.slice(0, 4).flatMap((m) => {
            const src = image(m?.src);
            if (!src || !KINDS.includes(m.kind) || !Number.isFinite(m.ratio)) return [];
            return [{ kind: m.kind, src, ratio: Math.min(10, Math.max(0.1, m.ratio)), label: m.label === "GIF" ? "GIF" : "" }];
        });
    }

    function cleanCard(p) {
        return {
            name: cut(p.name, 100),
            handle: p.handle,
            avatar: image(p.avatar),
            badge: BADGES.includes(p.badge) ? p.badge : "",
            postedAt: Number.isFinite(p.postedAt) ? p.postedAt : null,
            text: cut(p.text, 1000),
            alt: cut(p.alt, 1000),
            media: cleanMedia(p.media),
        };
    }

    function cleanSeen(raw, seenAt) {
        const id = typeof raw?.id === "string" ? raw.id : "";
        if (!/^\d{1,25}$/.test(id) || !isHandle(raw.handle)) return null;
        const q = raw.quoted;
        return { id, seenAt, ...cleanCard(raw), quoted: q && typeof q === "object" && isHandle(q.handle) ? cleanCard(q) : null };
    }

    // Saved scores still fresh enough to use, and from the model judging now (local: the Ollama model, or null for Jev,
    // which wrote the entries saved before local models), else null.
    const savedScores = (entry, now, local = null) => (entry && now - entry.t < SCORES_MS && (entry.model ?? null) === local ? cleanScores(entry.scores) : null);

    // Spending, by local day and month, and the month's total: { day: "YYYY-MM-DD", dayCost, month: "YYYY-MM", monthCost,
    // total, since } (see runningTotal). Days only move
    // forward, so a clock set back keeps counting on the later day instead of starting it again. A stored day more than
    // a day ahead of the clock is stale, so one write under a wrong clock can't hold "today" for months.
    const pad = (n) => String(n).padStart(2, "0");
    function dayOf(now) {
        const d = new Date(now);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    const DAY_MS = 86_400_000;
    // Whether the stored day and month still count: from today's, to at most a day ahead.
    function current(spend, now) {
        const day = dayOf(now);
        const soon = dayOf(now + DAY_MS);
        return {
            day: Boolean(spend) && spend.day >= day && spend.day <= soon,
            month: Boolean(spend) && spend.month >= day.slice(0, 7) && spend.month <= soon.slice(0, 7),
        };
    }

    function spentNow(spend, now) {
        const still = current(spend, now);
        return { today: still.day ? spend.dayCost : 0, month: still.month ? spend.monthCost : 0 };
    }

    // Local midnight on the 1st of this month, and of the next one.
    const monthStart = (now) => new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();
    const monthAfter = (now) => new Date(new Date(now).getFullYear(), new Date(now).getMonth() + 1, 1).getTime();

    // The month's spending the limit counts: { total, since }, since being the 1st, or your last reset if it was later
    // in the month. resetAt: when you last pressed Reset (storage.local spendReset). After a reset, a total that started
    // at any other time is from before it, even one the background wrote after it, so it reads as $0 from the reset.
    // Without one, a total from before the 1st (or more than a day ahead, under a wrong clock) gives way to this month's.
    function runningTotal(spend, now, resetAt) {
        const first = monthStart(now);
        const reset = Number.isFinite(resetAt) && resetAt >= first ? resetAt : null;
        const counts = reset === null ? spend?.since >= first && spend.since <= now + DAY_MS : spend?.since === reset;
        if (Number.isFinite(spend?.total) && counts) return { total: spend.total, since: spend.since };
        if (reset !== null) return { total: 0, since: reset };
        return { total: spentNow(spend, now).month, since: first };
    }

    function addSpend(spend, cost, now, resetAt) {
        const add = Number.isFinite(cost) && cost >= 0 ? cost : COST_GUESS;
        const day = dayOf(now);
        const still = current(spend, now);
        const { today, month } = spentNow(spend, now);
        const running = runningTotal(spend, now, resetAt);
        return {
            day: still.day && spend.day > day ? spend.day : day,
            dayCost: today + add,
            month: still.month && spend.month > day.slice(0, 7) ? spend.month : day.slice(0, 7),
            monthCost: month + add,
            total: running.total + add,
            since: running.since,
        };
    }

    // The limit holds until the 1st (monthAfter), or until you reset the spending or raise the limit.
    const limitReached = (spend, limit, now, resetAt) => limit !== null && runningTotal(spend, now, resetAt).total >= limit;

    function money(x) {
        if (x === 0) return "$0";
        if (x < 0.001) return "<$0.001";
        return x < 1 ? `$${x.toFixed(3).replace(/0$/, "")}` : `$${x.toFixed(2)}`;
    }

    globalThis.SiftVerdict = { QUALITIES, DEFAULT_THRESHOLDS, LOCAL_MODEL, LOCAL_THRESHOLDS, defaultThresholds, switchModel, LEARN, MIN_WORDS, SEEN_LIMIT, wordCount, cleanScores, settingsFrom, verdict, learn, learnFrom, cleanSeen, seenTrimDue, handleKey,
        SCORES_MS, COST_GUESS, savedScores, spentNow, runningTotal, addSpend, limitReached, monthAfter, money };
    if (typeof module !== "undefined") module.exports = globalThis.SiftVerdict;
})();
