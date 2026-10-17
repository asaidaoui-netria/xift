// Checks the popup's pure parts: today's numbers from the log, and which status line to show.
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("./popup-model.js");

const judged = (id, verdict, label = "") => ({ type: "judged", id, verdict, label });
const reused = (id, verdict, label = "") => ({ type: "skipped", reason: "reused", id, verdict, label });
const on = { collapseLittleText: true };

test("today counts posts, not answers: a post judged then reused on a reload counts once", () => {
    const t = M.today([judged("1", "collapsed", "Engagement bait 0.95"), reused("1", "collapsed", "Engagement bait 0.95"), judged("2", "open"), reused("3", "open")], on);
    assert.equal(t.judged, 3);
    assert.equal(t.reused, 2);
    assert.equal(t.collapsed, 1);
    assert.equal(t.by.bait, 1);
});

test("each collapsed post counts under its reason, and its latest one", () => {
    const t = M.today([
        judged("1", "collapsed", "Rage bait 0.91"), judged("2", "collapsed", "Low substance 0.95"), judged("3", "collapsed", "Self-promotion 0.9"),
        judged("4", "collapsed", "Engagement bait 0.8"), reused("4", "collapsed", "Rage bait 0.82"),
        { type: "skipped", reason: "too little text", id: "5" }, { type: "skipped", reason: "seen", id: "6" }, { type: "skipped", reason: "inherited", id: "7" },
    ], on);
    assert.deepEqual(t.by, { low: 1, bait: 0, little: 1, rage: 2, promo: 1, you: 0 });
    assert.equal(t.collapsed, 5);
});

test("too-short posts count only while that switch is on", () => {
    assert.equal(M.today([{ type: "skipped", reason: "too little text", id: "5" }], { collapseLittleText: false }).collapsed, 0);
});

test("your hides count as yours, and a later keep takes it back", () => {
    const t = M.today([judged("1", "open"), { type: "label", id: "1", wanted: "hide" }, { type: "label", id: "2", wanted: "hide" }, { type: "label", id: "2", wanted: "show" }], on);
    assert.equal(t.by.you, 1);
    assert.equal(t.collapsed, 1);
    assert.equal(t.corrections, 3);
});

test("a post you hid counts as yours, not under Jev's reason", () => {
    const t = M.today([judged("1", "collapsed", "Engagement bait 0.95"), { type: "label", id: "1", wanted: "hide" }], on);
    assert.deepEqual([t.by.bait, t.by.you, t.collapsed], [0, 1, 1]);
});

test("learning steps today", () => {
    assert.equal(M.today([{ type: "learn", key: "bait", from: 0.8, to: 0.82 }, { type: "learn", key: "low", from: 0.9, to: 0.88 }], on).steps, 2);
});

// Status: the first that applies, in this order.
const base = { enabled: true, access: true, key: true, lastError: null, paused: false };
test("the status line: off, then no access, no key, a stop, the daily limit, trouble, else sifting", () => {
    assert.equal(M.statusOf({ ...base, enabled: false, key: false }).kind, "off");
    assert.equal(M.statusOf({ ...base, access: false, key: false }).kind, "access");
    assert.equal(M.statusOf({ ...base, key: false }).kind, "nokey");
    assert.equal(M.statusOf({ ...base, lastError: { status: 402, kind: "permanent" }, paused: true }).kind, "credit");
    assert.equal(M.statusOf({ ...base, lastError: { status: 401, kind: "permanent" } }).kind, "badkey");
    assert.equal(M.statusOf({ ...base, lastError: { status: 418, kind: "permanent" } }).kind, "stopped");
    assert.equal(M.statusOf({ ...base, paused: true, lastError: { status: 429, kind: "temporary" } }).kind, "paused");
    assert.equal(M.statusOf({ ...base, lastError: { status: 429, kind: "temporary" } }).kind, "trouble");
    assert.deepEqual(M.statusOf({ ...base, lastError: { status: 400, kind: "post", message: "No such model" } }), { kind: "refused", status: 400, message: "No such model" });
    assert.deepEqual(M.statusOf({ ...base, lastError: { status: 404, kind: "permanent", message: "Not found" } }), { kind: "stopped", status: 404, message: "Not found" });
    assert.equal(M.statusOf(base).kind, "ok");
});

test("a local model needs no key and has no spending limit; a stop names Ollama's reason", () => {
    const local = { ...base, local: "nimble", key: false };
    assert.equal(M.statusOf(local).kind, "ok");
    assert.equal(M.statusOf({ ...local, paused: true }).kind, "ok");
    assert.equal(M.statusOf({ ...local, lastError: { status: "no key", kind: "permanent" } }).kind, "ok");
    assert.deepEqual(M.statusOf({ ...local, lastError: { status: 403, kind: "permanent", message: "Ollama refuses add-ons" } }), { kind: "stopped", status: 403, message: "Ollama refuses add-ons" });
    assert.equal(M.statusOf({ ...local, lastError: { status: 0, kind: "temporary" } }).kind, "trouble");
    assert.deepEqual(M.statusOf({ ...local, lastError: { status: 500, kind: "temporary", message: "model requires 11.5 GiB" } }), { kind: "trouble", status: 500, message: "model requires 11.5 GiB" });
});

test("a stop with no key is the missing key, whatever the error says", () => {
    assert.equal(M.statusOf({ ...base, key: false, lastError: { status: "no key", kind: "permanent" } }).kind, "nokey");
});

test("a post you kept no longer counts as sifted out", () => {
    const t = M.today([judged("1", "collapsed", "Rage bait 0.91"), { type: "label", id: "1", wanted: "show" }], on);
    assert.deepEqual([t.by.rage, t.collapsed], [0, 0]);
    const t2 = M.today([judged("1", "collapsed", "Rage bait 0.91"), { type: "label", id: "1", wanted: "hide" }, { type: "label", id: "1", wanted: "show" }], on);
    assert.deepEqual([t2.by.rage, t2.by.you, t2.collapsed], [0, 0, 0]);
});

test("a reused answer logged before 0.9.0 (no verdict) leaves the post's reason alone", () => {
    const t = M.today([judged("1", "collapsed", "Engagement bait 0.95"), { type: "skipped", reason: "reused", id: "1" }], on);
    assert.deepEqual([t.by.bait, t.collapsed, t.judged, t.reused], [1, 1, 1, 1]);
});

test("a \"no key\" error from before the key was saved is stale", () => {
    assert.equal(M.statusOf({ ...base, lastError: { status: "no key", kind: "permanent" } }).kind, "ok");
});

test("a key is one run of printable ASCII: a pasted ellipsis or space is caught before it's saved", () => {
    assert.equal(M.keyOk("sk-or-v1-0123abcd"), true);
    for (const key of ["sk-or-v1-0123…", "sk-or v1", "sk-or-v1-é", ""]) assert.equal(M.keyOk(key), false, key);
});

// What Report copies for you to paste into GitHub's form: versions, the status line, switches and thresholds. Never the
// key, an author you always show, or anything you read.
test("Report's details: versions, status, switches and thresholds, and nothing of yours", () => {
    const settings = { enabled: true, collapseAds: true, collapseLittleText: false, judgeReplies: true, focus: false, focusWidth: "900", focusText: "17",
        thresholds: { bait: 0.8, rage: 0.78, low: 0.9, promo: 0.85 }, dailyLimit: 0.5, seenLimit: 10000, trusted: ["someone_i_follow"], key: "sk-or-v1-secret" };
    const text = M.reportDetails({ version: "0.9.3", browser: { name: "Firefox", version: "140.0" }, os: "mac",
        status: { kind: "stopped", status: 404, message: "Model not found" }, settings });
    assert.equal(text, [
        "Xift 0.9.3 · Firefox 140.0 · mac",
        "Status: stopped (404: Model not found)",
        "Settings: on · ads collapse · too short show · replies judged · focus off (900, 17) · spending limit set",
        "Thresholds: bait 0.80 · rage 0.78 · low 0.90 · promo 0.85",
    ].join("\n"));
    assert.ok(!text.includes("someone_i_follow") && !text.includes("sk-or"));
    const quiet = M.reportDetails({ version: "0.9.3", browser: { name: "Firefox", version: "141.0" }, os: "linux", status: { kind: "ok" },
        settings: { ...settings, enabled: false, focus: true, dailyLimit: null } });
    assert.match(quiet, /^Status: ok$/m);
    assert.match(quiet, /^Settings: off · .* focus on \(900, 17\) · no spending limit$/m);
});
