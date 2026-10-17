// The popup's pure parts: today's numbers from the log, and which status line to show. No browser APIs, so the Node
// tests cover all of it. A classic script: the popup loads it after verdict.js.
(() => {
    // Why a post collapsed, by the start of its verdict label, in the order the popup lists them.
    const REASONS = [
        { key: "low", label: "Low substance" },
        { key: "bait", label: "Engagement bait" },
        { key: "little" },
        { key: "rage", label: "Rage bait" },
        { key: "promo", label: "Self-promotion" },
        { key: "you" },
    ];
    const reasonOf = (label) => REASONS.find((r) => r.label && String(label ?? "").startsWith(r.label))?.key ?? null;

    // Today's log, counted by post, not by answer: a post judged and then answered from saved scores on a reload counts
    // once, under its latest reason. Your correction outranks Jev: a Hide makes a post yours, a Keep takes it out.
    // judged: posts answered (by Jev or saved scores); reused: answers from saved scores; collapsed: posts collapsed,
    // split in `by`; corrections: your Keeps and Hides; steps: threshold changes they made.
    function today(entries, settings) {
        const answered = new Set();
        const why = new Map(); // post ID → reason key
        const yours = new Map(); // post ID → true while your latest correction is Hide
        let reused = 0, corrections = 0, steps = 0;
        for (const e of entries) {
            const id = String(e.id ?? "");
            if (e.type === "judged" || (e.type === "skipped" && e.reason === "reused")) {
                answered.add(id);
                if (e.type === "skipped") reused++;
                if (!e.verdict) continue; // a reused answer logged before 0.9.0 says nothing about the post
                const reason = e.verdict === "collapsed" ? reasonOf(e.label) : null;
                if (reason) why.set(id, reason);
                else why.delete(id);
            } else if (e.type === "skipped" && e.reason === "too little text") {
                if (settings.collapseLittleText) why.set(id, "little");
            } else if (e.type === "label") {
                corrections++;
                yours.set(id, e.wanted === "hide");
            } else if (e.type === "learn" && e.cause !== "slider" && e.cause !== "reset") {
                steps++;
            }
        }
        const by = Object.fromEntries(REASONS.map((r) => [r.key, 0]));
        for (const [id, reason] of why) if (!yours.has(id)) by[reason]++; // your Keep or Hide outranks Jev's reason
        for (const hid of yours.values()) if (hid) by.you++;
        const collapsed = Object.values(by).reduce((a, b) => a + b, 0);
        return { judged: answered.size, reused, collapsed, by, corrections, steps };
    }

    // The status line: the first that applies. A refused post shows until the next post Jev judges, so a Jev that
    // refuses every post (a retired model) doesn't hide behind "Sifting". message: OpenRouter's reason, when it gave one.
    // local: the Ollama model judging, which needs no key and costs nothing, or null for Jev.
    function statusOf({ enabled, access, key, lastError, paused, local = null }) {
        const why = lastError?.message ? { message: lastError.message } : {};
        if (!enabled) return { kind: "off" };
        if (!access) return { kind: "access" };
        if (!key && !local) return { kind: "nokey" };
        // A "no key" error written just before the key was saved is stale once there is one.
        if (lastError?.kind === "permanent" && lastError.status !== "no key") {
            if (lastError.status === 402 && !local) return { kind: "credit" };
            if (lastError.status === 401 && !local) return { kind: "badkey" };
            return { kind: "stopped", status: lastError.status, ...why };
        }
        if (paused && !local) return { kind: "paused" };
        if (lastError?.kind === "temporary") return { kind: "trouble", status: lastError.status, ...why };
        if (lastError?.kind === "post") return { kind: "refused", status: lastError.status, ...why };
        return { kind: "ok" };
    }

    // An OpenRouter key is one run of printable ASCII; a copied "…" or space would fail every call as a network error.
    const keyOk = (key) => /^[\x21-\x7e]+$/.test(key);

    // What Report copies for you to paste into GitHub's issue form: Xift's and Firefox's versions, the status line, the
    // switches and the thresholds. Xift sends none of it itself. Never the key, the Always show list, or what you read.
    function reportDetails({ version, browser, os, status, settings: s }) {
        const why = status.status !== undefined ? ` (${status.status}${status.message ? `: ${status.message}` : ""})` : "";
        const on = (x, yes, no) => (x ? yes : no);
        return [
            `Xift ${version} · ${browser.name} ${browser.version} · ${os}`,
            `Status: ${status.kind}${why}`,
            `Settings: ${on(s.enabled, "on", "off")} · ads ${on(s.collapseAds, "collapse", "show")} · too short ${on(s.collapseLittleText, "collapse", "show")} · replies ${on(s.judgeReplies, "judged", "not judged")} · focus ${on(s.focus, "on", "off")} (${s.focusWidth}, ${s.focusText}) · ${on(s.dailyLimit, "spending limit set", "no spending limit")}`,
            `Thresholds: ${Object.entries(s.thresholds).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(" · ")}`,
        ].join("\n");
    }

    globalThis.SiftPopup = { REASONS, today, statusOf, keyOk, reportDetails };
    if (typeof module !== "undefined") module.exports = globalThis.SiftPopup;
})();
