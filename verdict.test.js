// Checks Xift's verdict rule, learning, settings and score checks.
// Spending is counted by local day: a zone off UTC catches a UTC date slipping in (this machine runs on UTC).
process.env.TZ = "America/New_York";
const test = require("node:test");
const assert = require("node:assert/strict");
const V = require("./verdict.js");

const T = { bait: 0.8, rage: 0.8, low: 0.9, promo: 0.85 };
const settings = { enabled: true, collapseAds: true, collapseLittleText: true, judgeReplies: true, thresholds: T, focus: false, focusWidth: "900", focusText: "17", seenLimit: 10000, dailyLimit: 1, trusted: [], local: null, localModel: V.LOCAL_MODEL };
const quiet = { bait: 0.1, rage: 0.05, low: 0.2, promo: 0.02 };

test("defaults match the calibration run", () => {
    assert.deepEqual(V.DEFAULT_THRESHOLDS, T);
    assert.deepEqual(V.QUALITIES.map((q) => q.key), ["bait", "rage", "low", "promo"]);
});

test("a post under every threshold stays open", () => {
    assert.deepEqual(V.verdict({ scores: quiet }, settings), { collapsed: false, label: "" });
});

test("a score at its threshold collapses, labelled with the quality and score", () => {
    assert.deepEqual(V.verdict({ scores: { ...quiet, rage: 0.8 } }, settings), { collapsed: true, label: "Rage bait 0.80" });
});

test("the reason is the quality furthest over its threshold", () => {
    // bait 0.96 is 0.16 over its threshold; low 0.96 only 0.06
    assert.deepEqual(V.verdict({ scores: { bait: 0.96, rage: 0.2, low: 0.96, promo: 0.04 } }, settings), { collapsed: true, label: "Engagement bait 0.96" });
});

test("your correction wins over the scores", () => {
    assert.deepEqual(V.verdict({ scores: { ...quiet, bait: 0.99 }, byYou: "show" }, settings), { collapsed: false, label: "" });
    assert.deepEqual(V.verdict({ scores: quiet, byYou: "hide" }, settings), { collapsed: true, label: "Hidden by you" });
});

test("ads and too-little-text posts follow their switches", () => {
    assert.deepEqual(V.verdict({ ad: true }, settings), { collapsed: true, label: "Ad" });
    assert.deepEqual(V.verdict({ ad: true }, { ...settings, collapseAds: false }), { collapsed: false, label: "" });
    assert.deepEqual(V.verdict({ tooLittle: true }, settings), { collapsed: true, label: "Too little text" });
    assert.deepEqual(V.verdict({ tooLittle: true }, { ...settings, collapseLittleText: false }), { collapsed: false, label: "" });
});

test("settings fill in defaults and drop invalid thresholds", () => {
    assert.deepEqual(V.settingsFrom({}), settings);
    assert.deepEqual(V.settingsFrom({ enabled: false, collapseAds: false, thresholds: { bait: 0.5, rage: 7, low: "x" } }), {
        enabled: false,
        collapseAds: false,
        collapseLittleText: true,
        judgeReplies: true,
        thresholds: { bait: 0.5, rage: 0.8, low: 0.9, promo: 0.85 },
        focus: false,
        focusWidth: "900",
        focusText: "17",
        seenLimit: 10000,
        dailyLimit: 1,
        trusted: [],
        local: null,
        localModel: V.LOCAL_MODEL,
    });
});

test("focus settings keep only the popup's choices", () => {
    const focusOf = ({ focus, focusWidth, focusText }) => ({ focus, focusWidth, focusText });
    assert.deepEqual(focusOf(V.settingsFrom({ focus: true, focusWidth: "fill", focusText: "x" })), { focus: true, focusWidth: "fill", focusText: "x" });
    assert.deepEqual(focusOf(V.settingsFrom({ focus: true, focusWidth: "760", focusText: "19" })), { focus: true, focusWidth: "760", focusText: "19" });
    assert.deepEqual(focusOf(V.settingsFrom({ focus: "yes", focusWidth: 900, focusText: "21" })), { focus: false, focusWidth: "900", focusText: "17" });
});

test("cleanScores accepts four probabilities and rejects anything else", () => {
    assert.deepEqual(V.cleanScores({ ...quiet, extra: 5 }), quiet);
    assert.equal(V.cleanScores({ ...quiet, low: 1.2 }), null);
    assert.equal(V.cleanScores({ ...quiet, rage: "0.5" }), null);
    assert.equal(V.cleanScores({ bait: 0.1 }), null);
    assert.equal(V.cleanScores(null), null);
});

test("keep on a collapsed post raises each threshold it crossed by one step", () => {
    const { thresholds, changes } = V.learn(T, { bait: 0.96, rage: 0.2, low: 0.95, promo: 0.04 }, "show");
    assert.deepEqual(thresholds, { ...T, bait: 0.82, low: 0.92 });
    assert.deepEqual(changes, [
        { key: "bait", from: 0.8, to: 0.82 },
        { key: "low", from: 0.9, to: 0.92 },
    ]);
});

test("hide on an open post lowers the closest threshold within reach", () => {
    // rage 0.7 is 0.1 under its threshold; low 0.75 is 0.15 under
    const { thresholds, changes } = V.learn(T, { bait: 0.3, rage: 0.7, low: 0.75, promo: 0.1 }, "hide");
    assert.deepEqual(thresholds, { ...T, rage: 0.78 });
    assert.deepEqual(changes, [{ key: "rage", from: 0.8, to: 0.78 }]);
});

test("hide on a post far from every threshold teaches nothing", () => {
    assert.deepEqual(V.learn(T, { bait: 0.1, rage: 0.05, low: 0.55, promo: 0.1 }, "hide"), { thresholds: T, changes: [] });
});

test("clicks that agree with Xift teach nothing", () => {
    assert.deepEqual(V.learn(T, quiet, "show"), { thresholds: T, changes: [] }); // keep on an open post
    assert.deepEqual(V.learn(T, { ...quiet, bait: 0.9 }, "hide"), { thresholds: T, changes: [] }); // hide on a collapsed post
});

test("learning stays within 0.05 and 0.99", () => {
    assert.equal(V.learn({ ...T, bait: 0.98 }, { ...quiet, bait: 0.999 }, "show").thresholds.bait, 0.99);
    assert.equal(V.learn({ ...T, rage: 0.06 }, { bait: 0, rage: 0.05, low: 0, promo: 0 }, "hide").thresholds.rage, 0.05);
});

test("keep on a post you hid takes back that hide's step, once", () => {
    const near = { bait: 0.3, rage: 0.7, low: 0.75, promo: 0.1 };
    const hide = V.learnFrom(T, undefined, near, "hide");
    assert.deepEqual(hide.steps, [{ key: "rage", from: 0.8, to: 0.78 }]);
    assert.equal(hide.cause, "hide");
    const keep = V.learnFrom(hide.thresholds, { wanted: "hide", steps: hide.steps }, undefined, "show");
    assert.deepEqual(keep, { thresholds: T, changes: [{ key: "rage", from: 0.78, to: 0.8 }], cause: "undo", steps: [] });
    // A corrected post sends no scores: hiding it again stores no steps, so keeping it again changes nothing.
    const again = V.learnFrom(keep.thresholds, { wanted: "show", steps: [] }, undefined, "hide");
    assert.deepEqual(again, { thresholds: T, changes: [], cause: "hide", steps: [] });
    assert.deepEqual(V.learnFrom(T, { wanted: "hide", steps: again.steps }, undefined, "show").changes, []);
});

test("undo moves by the hide's amount from where the threshold is now, within the limits", () => {
    const steps = [{ key: "rage", from: 0.8, to: 0.78 }];
    assert.equal(V.learnFrom({ ...T, rage: 0.7 }, { wanted: "hide", steps }, undefined, "show").thresholds.rage, 0.72);
    assert.equal(V.learnFrom({ ...T, rage: 0.98 }, { wanted: "hide", steps }, undefined, "show").thresholds.rage, 0.99);
    assert.deepEqual(V.learnFrom(T, { wanted: "hide", steps: [{ key: "nope", from: 1, to: 0 }] }, undefined, "show").changes, []);
});

test("a hide or keep with no earlier correction learns as before", () => {
    const scores = { bait: 0.96, rage: 0.2, low: 0.95, promo: 0.04 };
    const keep = V.learnFrom(T, undefined, scores, "show");
    assert.deepEqual(keep, { ...V.learn(T, scores, "show"), cause: "keep", steps: [] });
    assert.deepEqual(V.learnFrom(T, { wanted: "show", steps: [] }, undefined, "show"), { thresholds: T, changes: [], cause: "keep", steps: [] });
});

test("word count ignores emoji", () => {
    assert.equal(V.wordCount("look at this 👀"), 3);
    assert.ok(V.wordCount("look at this 👀") < V.MIN_WORDS);
    assert.equal(V.wordCount("🚨👇🧵"), 0);
    assert.equal(V.wordCount("❤️ ❤️ ❤️"), 0);
});

test("word count handles numbers, punctuation, Arabic and missing text", () => {
    assert.equal(V.wordCount("Rust 2026: fast, safe, fun!"), 5);
    assert.equal(V.wordCount("مرحبا بكم في المغرب"), 4);
    assert.equal(V.wordCount(""), 0);
    assert.equal(V.wordCount(undefined), 0);
});

test("the seen limit is a whole number from 100 to 100,000", () => {
    const limit = (seenLimit) => V.settingsFrom({ seenLimit }).seenLimit;
    assert.equal(limit(undefined), 10000);
    assert.equal(limit(2500), 2500);
    assert.equal(limit(2500.6), 2501);
    assert.equal(limit(5), 100);
    assert.equal(limit(1e9), 100000);
    for (const junk of ["1000", NaN, Infinity, null, {}]) assert.equal(limit(junk), 10000, String(junk));
});

// A record as content.js sends it.
const raw = () => ({
    id: "1840000000000000001", name: "Ana", handle: "ana_b", avatar: "https://pbs.twimg.com/profile_images/1/a_normal.jpg", badge: "blue",
    postedAt: 1760000000000, text: "Hello\nworld", alt: "a cat",
    media: [{ kind: "photo", src: "https://pbs.twimg.com/media/X?format=jpg&name=small", ratio: 1.5, label: "" }],
    quoted: { name: "Bo", handle: "bo", avatar: "https://abs.twimg.com/sticky/default_profile_images/d_normal.png", badge: "", postedAt: null, text: "q", alt: "", media: [] },
});

test("a seen record keeps the known fields, with the background's time", () => {
    const r = V.cleanSeen({ ...raw(), seenAt: 5, extra: "dropped" }, 1760000001000);
    assert.deepEqual(r, { ...raw(), seenAt: 1760000001000, quoted: { ...raw().quoted } });
    assert.equal("extra" in r, false);
});

test("a seen record needs a post ID and a handle", () => {
    for (const id of ["", "12a", "1".repeat(26), undefined]) assert.equal(V.cleanSeen({ ...raw(), id }, 1), null, String(id));
    for (const handle of ["", "a/..", "a".repeat(16), "@ana", undefined]) assert.equal(V.cleanSeen({ ...raw(), handle }, 1), null, String(handle));
});

test("text is cut, and the badge must be one X uses", () => {
    const r = V.cleanSeen({ ...raw(), text: "x".repeat(1500), alt: "y".repeat(1500), name: "n".repeat(200), badge: "__proto__" }, 1);
    assert.equal(r.text.length, 1000);
    assert.equal(r.alt.length, 1000);
    assert.equal(r.name.length, 100);
    assert.equal(r.badge, "");
});

test("image URLs must be X's own image hosts", () => {
    for (const avatar of ["http://pbs.twimg.com/a.jpg", "https://pbs.twimg.com.evil.com/a.jpg", "https://evil.com/https://pbs.twimg.com/", "javascript:alert(1)", 7]) {
        assert.equal(V.cleanSeen({ ...raw(), avatar }, 1).avatar, "", String(avatar));
    }
    assert.equal(V.cleanSeen({ ...raw(), avatar: "https://pbs.twimg.com/a.jpg)" }, 1).avatar, "https://pbs.twimg.com/a.jpg)"); // only ever used as img.src
});

test("media: at most 4 of a known kind, with a sane shape", () => {
    const m = (over) => ({ kind: "photo", src: "https://pbs.twimg.com/media/X", ratio: 1, label: "", ...over });
    const media = (list) => V.cleanSeen({ ...raw(), media: list }, 1).media;
    assert.equal(media([m(), m(), m(), m(), m()]).length, 4);
    assert.deepEqual(media([m({ kind: "audio" }), m({ src: "https://evil.com/x" }), m({ ratio: NaN }), m({ ratio: "1" })]), []);
    assert.deepEqual(media([m({ ratio: 0 }), m({ ratio: 1e9 })]).map((x) => x.ratio), [0.1, 10]);
    assert.deepEqual(media([m({ kind: "gif", label: "GIF" }), m({ label: "0:42" })]).map((x) => x.label), ["GIF", ""]);
    assert.deepEqual(media("nope"), []);
});

test("a quoted post needs its own handle, and loses any quote of its own", () => {
    assert.equal(V.cleanSeen({ ...raw(), quoted: { ...raw().quoted, handle: "no way" } }, 1).quoted, null);
    assert.equal(V.cleanSeen({ ...raw(), quoted: null }, 1).quoted, null);
    assert.equal("quoted" in V.cleanSeen({ ...raw(), quoted: { ...raw().quoted, quoted: raw().quoted } }, 1).quoted, false);
});

test("the Seen list trims on the first save after the background wakes, then every 100th", () => {
    assert.equal(V.seenTrimDue(1), true);
    for (const n of [2, 50, 100]) assert.equal(V.seenTrimDue(n), false, String(n));
    assert.equal(V.seenTrimDue(101), true);
});

test("the spending limit is $1 a month unless you set one; 0 means none", () => {
    const limit = (dailyLimit) => V.settingsFrom({ dailyLimit }).dailyLimit;
    assert.equal(limit(0.5), 0.5);
    assert.equal(limit(0.0004), 0.0004);
    for (const unset of [undefined, null, "0.5", NaN, Infinity]) assert.equal(limit(unset), 1, String(unset));
    for (const none of [0, -1]) assert.equal(limit(none), null, String(none));
});

// Spending, by local day and month. 2026-11-01T02:00Z is still Oct 31 in New York.
const at = (iso) => new Date(iso).getTime();
const days = ({ day, dayCost, month, monthCost }) => ({ day, dayCost, month, monthCost });

test("spending adds up through the day and the month", () => {
    let spend = V.addSpend(undefined, 0.01, at("2026-10-16T10:00:00-04:00"));
    assert.deepEqual(days(spend), { day: "2026-10-16", dayCost: 0.01, month: "2026-10", monthCost: 0.01 });
    spend = V.addSpend(spend, 0.02, at("2026-10-16T23:59:00-04:00"));
    assert.deepEqual(V.spentNow(spend, at("2026-10-16T23:59:30-04:00")), { today: 0.03, month: 0.03 });
});

test("a new day starts at local midnight, and a new month at the 1st", () => {
    const oct31 = V.addSpend(V.addSpend(undefined, 0.01, at("2026-10-30T12:00:00-04:00")), 0.02, at("2026-11-01T02:00:00Z"));
    assert.deepEqual(days(oct31), { day: "2026-10-31", dayCost: 0.02, month: "2026-10", monthCost: 0.03 });
    assert.deepEqual(V.spentNow(oct31, at("2026-11-01T12:00:00-04:00")), { today: 0, month: 0 });
    assert.deepEqual(days(V.addSpend(oct31, 0.05, at("2026-11-01T12:00:00-04:00"))), { day: "2026-11-01", dayCost: 0.05, month: "2026-11", monthCost: 0.05 });
});

test("a clock set back keeps counting on the later day", () => {
    const spend = V.addSpend(undefined, 0.01, at("2026-10-17T00:30:00-04:00"));
    assert.deepEqual(days(V.addSpend(spend, 0.01, at("2026-10-16T23:30:00-04:00"))), { day: "2026-10-17", dayCost: 0.02, month: "2026-10", monthCost: 0.02 });
    assert.deepEqual(V.spentNow(spend, at("2026-10-16T23:30:00-04:00")), { today: 0.01, month: 0.01 });
});

test("a stored day more than a day ahead is stale: one write under a wrong clock can't hold today for months", () => {
    const future = V.addSpend(undefined, 0.5, at("2027-03-01T12:00:00-05:00"));
    const now = at("2026-10-16T12:00:00-04:00");
    assert.deepEqual(V.spentNow(future, now), { today: 0, month: 0 });
    assert.deepEqual(days(V.addSpend(future, 0.01, now)), { day: "2026-10-16", dayCost: 0.01, month: "2026-10", monthCost: 0.01 });
    // A day ahead is still a clock set back, also across the end of the month.
    const nov1 = V.addSpend(undefined, 0.01, at("2026-11-01T00:30:00-04:00"));
    assert.deepEqual(V.spentNow(nov1, at("2026-10-31T23:30:00-04:00")), { today: 0.01, month: 0.01 });
});

test("a call without a reported cost counts as a typical text call", () => {
    for (const cost of [null, undefined, NaN, -1, "0.1"]) assert.equal(V.addSpend(undefined, cost, at("2026-10-16T12:00:00-04:00")).dayCost, V.COST_GUESS, String(cost));
});

// The month's spending: from the 1st, or from a reset later in the month (0.1.0).
const t10 = at("2026-10-16T10:00:00-04:00");
const t11 = at("2026-10-16T11:00:00-04:00");
const t12 = at("2026-10-16T12:00:00-04:00");
const oct1 = at("2026-10-01T00:00:00-04:00");
const nov1 = at("2026-11-01T00:00:00-04:00");

test("the spending counts from the 1st of the month", () => {
    let spend = V.addSpend(undefined, 0.25, t10);
    assert.deepEqual(V.runningTotal(spend, t10), { total: 0.25, since: oct1 });
    spend = V.addSpend(spend, 0.5, at("2026-10-20T10:00:00-04:00"));
    assert.deepEqual(V.runningTotal(spend, at("2026-10-31T23:00:00-04:00")), { total: 0.75, since: oct1 });
    assert.deepEqual(V.runningTotal(undefined, t10), { total: 0, since: oct1 });
});

test("a new month starts again from $0 on the 1st", () => {
    const spend = V.addSpend(undefined, 0.75, t10);
    const nov3 = at("2026-11-03T10:00:00-05:00");
    assert.deepEqual(V.runningTotal(spend, nov3), { total: 0, since: nov1 });
    assert.deepEqual(V.runningTotal(V.addSpend(spend, 0.5, nov3), nov3), { total: 0.5, since: nov1 });
});

test("a reset starts the total at $0 from then; today and this month still count", () => {
    const spend = V.addSpend(undefined, 0.5, t10);
    assert.deepEqual(V.runningTotal(spend, t12, t11), { total: 0, since: t11 });
    const next = V.addSpend(spend, 0.25, t12, t11);
    assert.deepEqual(V.runningTotal(next, t12, t11), { total: 0.25, since: t11 });
    assert.deepEqual(V.spentNow(next, t12), { today: 0.75, month: 0.75 });
    assert.deepEqual(V.runningTotal(undefined, t12, t11), { total: 0, since: t11 });
});

test("a reset from an earlier month no longer counts: the new month counts from the 1st", () => {
    const sep20 = at("2026-09-20T10:00:00-04:00");
    const spend = V.addSpend(V.addSpend(undefined, 0.5, sep20, sep20), 0.25, t10, sep20);
    assert.deepEqual(V.runningTotal(spend, t12, sep20), { total: 0.25, since: oct1 });
});

test("a total the background read before a reset and wrote after it still reads as $0", () => {
    const stale = V.addSpend(V.addSpend(undefined, 0.5, t10), 0.25, t12); // counted without the reset at 11:00
    assert.deepEqual(V.runningTotal(stale, t12, t11), { total: 0, since: t11 });
    assert.equal(V.limitReached(stale, 0.1, t12, t11), false);
});

test("a reset counts under a clock set back too", () => {
    const spend = V.addSpend(undefined, 0.5, at("2026-10-17T10:00:00-04:00"));
    assert.deepEqual(V.runningTotal(spend, t12, t11), { total: 0, since: t11 });
});

test("a total started more than a day ahead is stale: one write under a wrong clock can't hold the month", () => {
    const future = V.addSpend(undefined, 0.5, at("2027-03-01T12:00:00-05:00"));
    assert.deepEqual(V.runningTotal(future, t12), { total: 0, since: oct1 });
});

test("spending saved without a total counts this month's, since the 1st", () => {
    const old = { day: "2026-10-16", dayCost: 0.25, month: "2026-10", monthCost: 0.5 };
    assert.deepEqual(V.runningTotal(old, at("2026-10-17T12:00:00-04:00")), { total: 0.5, since: oct1 });
    assert.deepEqual(V.runningTotal(V.addSpend(old, 0.25, at("2026-10-17T12:00:00-04:00")), at("2026-10-18T12:00:00-04:00")), { total: 0.75, since: oct1 });
    assert.deepEqual(V.runningTotal(old, at("2026-11-02T12:00:00-05:00")), { total: 0, since: nov1 }); // a month that's over
    assert.deepEqual(V.runningTotal(old, at("2026-10-17T12:00:00-04:00"), t12), { total: 0, since: t12 }); // reset before the next call
});

test("the limit is reached when the month's spending gets to it, and holds until the 1st or a reset", () => {
    const spend = V.addSpend(undefined, 0.5, t10);
    assert.equal(V.limitReached(spend, 0.5, t11), true);
    assert.equal(V.limitReached(spend, 0.51, t11), false);
    assert.equal(V.limitReached(spend, 0.5, at("2026-10-31T23:59:00-04:00")), true);
    assert.equal(V.limitReached(spend, 0.5, nov1), false);
    assert.equal(V.limitReached(spend, 0.5, t12, t11), false);
    assert.equal(V.limitReached(spend, null, t11), false);
    assert.equal(V.limitReached(undefined, 0.5, t11), false);
});

test("a pause by the limit lasts until local midnight on the 1st of next month", () => {
    assert.equal(V.monthAfter(t10), nov1);
    assert.equal(V.monthAfter(at("2026-12-31T23:00:00-05:00")), at("2027-01-01T00:00:00-05:00"));
});

test("amounts show to a tenth of a cent", () => {
    assert.equal(V.money(0), "$0");
    assert.equal(V.money(0.0004), "<$0.001");
    assert.equal(V.money(0.031), "$0.031");
    assert.equal(V.money(0.62), "$0.62");
    assert.equal(V.money(0.6), "$0.60");
    assert.equal(V.money(1.234), "$1.23");
});

test("saved scores are used for 7 days", () => {
    const scores = { bait: 0.9, rage: 0.1, low: 0.2, promo: 0 };
    const t = at("2026-10-16T12:00:00Z");
    assert.deepEqual(V.savedScores({ scores, t }, t + 7 * 86_400_000 - 1), scores);
    assert.equal(V.savedScores({ scores, t }, t + 7 * 86_400_000), null);
    assert.equal(V.savedScores({ scores: { ...scores, low: 2 }, t }, t), null);
    assert.equal(V.savedScores(undefined, t), null);
});

test("saved scores are reused only by the model that gave them; older entries are Jev's", () => {
    const scores = { bait: 0.9, rage: 0.1, low: 0.2, promo: 0 };
    const t = at("2026-10-16T12:00:00Z");
    assert.deepEqual(V.savedScores({ scores, t }, t, null), scores);
    assert.equal(V.savedScores({ scores, t }, t, "tev1:4b"), null);
    assert.deepEqual(V.savedScores({ scores, t, model: "tev1:4b" }, t, "tev1:4b"), scores);
    assert.equal(V.savedScores({ scores, t, model: "tev1:4b" }, t, null), null);
    assert.equal(V.savedScores({ scores, t, model: "tev1:4b" }, t, "nimble"), null);
});

test("an author you always show is stored as the handle alone, lowercase, once", () => {
    assert.equal(V.handleKey("@Ana_B"), "ana_b");
    assert.equal(V.handleKey("ana_b"), "ana_b");
    for (const bad of ["", "@", "a b", "x".repeat(16), "@ana/..", null, 7]) assert.equal(V.handleKey(bad), null, String(bad));
    assert.deepEqual(V.settingsFrom({ trusted: ["Ana", "@bo_b", "ana", "a b", 7] }).trusted, ["ana", "bo_b"]);
    assert.deepEqual(V.settingsFrom({ trusted: "ana" }).trusted, []);
    assert.equal(V.settingsFrom({ trusted: Array.from({ length: 1200 }, (_, i) => `u${i}`) }).trusted.length, 1000);
});

test("a post by an author you always show stays open, unless you hid it yourself", () => {
    assert.deepEqual(V.verdict({ trusted: true }, settings), { collapsed: false, label: "" });
    assert.deepEqual(V.verdict({ trusted: true, byYou: "hide" }, settings), { collapsed: true, label: "Hidden by you" });
});

test("a local provider names its Ollama model, a bad name falls back to the default", () => {
    assert.equal(V.settingsFrom({ provider: "local", localModel: "tev1:4b" }).local, "tev1:4b");
    assert.equal(V.settingsFrom({ provider: "local", localModel: "a b; rm" }).local, V.LOCAL_MODEL);
    assert.equal(V.settingsFrom({ provider: "local" }).local, V.LOCAL_MODEL);
    assert.equal(V.settingsFrom({ localModel: "tev1:4b" }).local, null);
    assert.equal(V.settingsFrom({ localModel: "tev1:4b" }).localModel, "tev1:4b");
});

test("each model starts from its own thresholds: Jev's for Jev and unknown models", () => {
    assert.deepEqual(V.defaultThresholds(null), T);
    assert.deepEqual(V.defaultThresholds("someone/new-model"), T);
    assert.deepEqual(V.defaultThresholds(V.LOCAL_MODEL), V.LOCAL_THRESHOLDS[V.LOCAL_MODEL]);
    assert.deepEqual(V.settingsFrom({ provider: "local" }).thresholds, V.LOCAL_THRESHOLDS[V.LOCAL_MODEL]);
});

test("switching models keeps each model's learnt thresholds, and switching back restores them", () => {
    const learnt = { bait: 0.7, rage: 0.82, low: 0.88, promo: 0.85 };
    const toLocal = V.switchModel({ thresholds: learnt }, { provider: "local", localModel: V.LOCAL_MODEL });
    assert.deepEqual(toLocal, { provider: "local", localModel: V.LOCAL_MODEL, thresholds: V.LOCAL_THRESHOLDS[V.LOCAL_MODEL], savedThresholds: { jev: learnt } });
    const localLearnt = { bait: 0.4, rage: 0.5, low: 0.5, promo: 0.6 };
    const back = V.switchModel({ ...toLocal, thresholds: localLearnt }, { provider: "openrouter", localModel: V.LOCAL_MODEL });
    assert.deepEqual(back.thresholds, learnt);
    assert.deepEqual(back.savedThresholds, { jev: learnt, [`local:${V.LOCAL_MODEL}`]: localLearnt });
    const again = V.switchModel(back, { provider: "local", localModel: V.LOCAL_MODEL });
    assert.deepEqual(again.thresholds, localLearnt);
});

test("a saved threshold set that went bad falls back to that model's defaults", () => {
    const next = V.switchModel({ savedThresholds: { "local:tev1:4b": { bait: 7 } } }, { provider: "local", localModel: "tev1:4b" });
    assert.deepEqual(next.thresholds, V.defaultThresholds("tev1:4b"));
});
