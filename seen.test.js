// Checks the Seen list's search and X-style dates.
const test = require("node:test");
const assert = require("node:assert/strict");
const { wordsOf, haystack, matches, postedLabel, dayLabel } = require("./seen.js");

const rec = { text: "IndexedDB is fine", alt: "a red cat", name: "Ana B", handle: "ana_b", quoted: { text: "Postgres queues", alt: "", name: "Bo", handle: "bo_c" } };

test("search needs every word, ignoring case, across the post and its quote", () => {
    const hay = haystack(rec);
    assert.equal(matches(hay, wordsOf("indexeddb FINE")), true);
    assert.equal(matches(hay, wordsOf("cat")), true); // image descriptions
    assert.equal(matches(hay, wordsOf("@ana_b")), true);
    assert.equal(matches(hay, wordsOf("postgres bo_c")), true); // the quoted post
    assert.equal(matches(hay, wordsOf("indexeddb mysql")), false);
    assert.equal(matches(hay, wordsOf("   ")), true);
});

test("a post without a quote still searches", () => {
    assert.equal(matches(haystack({ ...rec, quoted: null }), wordsOf("ana")), true);
});

test("dates in X's style", () => {
    const now = new Date(2026, 9, 15, 18, 0).getTime();
    assert.equal(postedLabel(now - 42 * 60_000, now), "42m");
    assert.equal(postedLabel(now - 30_000, now), "1m");
    assert.equal(postedLabel(now - 5 * 3_600_000, now), "5h");
    assert.equal(postedLabel(new Date(2026, 9, 13, 9).getTime(), now), "Oct 13");
    assert.equal(postedLabel(new Date(2025, 9, 13, 9).getTime(), now), "Oct 13, 2025");
    assert.equal(postedLabel(null, now), "");
});

test("day headings", () => {
    const now = new Date(2026, 9, 15, 18, 0).getTime();
    assert.equal(dayLabel(new Date(2026, 9, 15, 8).getTime(), now), "Seen today");
    assert.equal(dayLabel(new Date(2026, 9, 14, 23).getTime(), now), "Seen yesterday");
    assert.equal(dayLabel(new Date(2026, 9, 12, 9).getTime(), now), "Seen Monday, Oct 12");
    assert.equal(dayLabel(new Date(2025, 9, 13, 9).getTime(), now), "Seen Monday, Oct 13, 2025");
});
