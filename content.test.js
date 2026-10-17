// Checks which pages Xift filters and how a timeline cell's mark is chosen.
const test = require("node:test");
const assert = require("node:assert/strict");
const { pathMode, replyJudged, decide, learnableScores, pick, readingLine, exitEdges, readOn, focusPick, skipSeen, seenLabel, tally, readable, SEEN_MS, replyOf, aheadAt, focusStep, passStep, jRecords, userParts, described } = require("./content.js");

const collapsed = { collapsed: true, label: "Rage bait 0.90" };
const open = { collapsed: false, label: "" };

test("filters the home timeline, search and lists; judges the replies on a post's page", () => {
    for (const path of ["/home", "/search", "/i/lists/1234567890"]) assert.equal(pathMode(path), "filter", path);
    for (const path of ["/ana/status/1", "/Ana_B/status/2111066492947054660", "/i/web/status/20"]) assert.equal(pathMode(path), "post", path);
    for (const path of ["/", "/homepage", "/notifications", "/ana", "/i/lists/123/members", "/explore", "/ana/status/1/quotes", "/ana/status/x", "/a/b/status/1"]) {
        assert.equal(pathMode(path), "off", path);
    }
});

// On a post's page only the replies below it are judged: X's IDs grow with time, so a reply's is newer than the post's,
// and the posts shown above it (what it replies to) are older. Its author's own replies are its thread: never judged.
test("on a post's page, only newer posts by someone else are judged", () => {
    const path = "/thdxr/status/2111066492947054660";
    assert.equal(replyJudged(path, "2111070875160293848", "@vimtor", "thdxr"), true); // a reply
    assert.equal(replyJudged(path, "2111066492947054660", "@thdxr", "thdxr"), false); // the post itself
    assert.equal(replyJudged(path, "2111066492947054000", "@someone", "thdxr"), false); // above it: older
    assert.equal(replyJudged(path, "2111070875160293999", "@THDXR", "thdxr"), false); // the author's own reply
    assert.equal(replyJudged(path, "999999999999999999999", "@vimtor", "thdxr"), true); // past 2^53: compared exactly
    // The author comes from the page: /i/status/ (the Seen list's links) and /i/web/status/ name nobody.
    assert.equal(replyJudged("/i/status/20", "21", "@ana", "ana"), false);
    assert.equal(replyJudged("/i/status/20", "21", "@bo", "ana"), true);
    assert.equal(replyJudged("/i/web/status/20", "21", "@ana", null), true); // author unknown: every newer post
    assert.equal(replyJudged("/home", "21", "@ana", "ana"), false);
});

test("freezes on modal routes that keep the timeline mounted", () => {
    for (const path of ["/ana/status/1/photo/1", "/ana/status/1/video/1", "/compose/post"]) assert.equal(pathMode(path), "freeze", path);
});

test("a new post is blurred and sent", () => {
    assert.deepEqual(decide({}), { sift: "pending", label: null, send: true, defer: false });
});

test("a post already waiting is not sent twice", () => {
    assert.deepEqual(decide({ current: "pending", inFlight: true }), { sift: "pending", label: null, send: false, defer: false });
});

test("a remembered collapse applies directly on a fresh mount", () => {
    assert.deepEqual(decide({ verdict: collapsed, current: null }), { sift: "collapsed", label: "Rage bait 0.90", send: false, defer: false });
});

test("a late collapse in or below the viewport applies at once", () => {
    assert.deepEqual(decide({ verdict: collapsed, current: "pending", above: false }), { sift: "collapsed", label: "Rage bait 0.90", send: false, defer: false });
});

test("a late collapse above the viewport is deferred, and the node stays open", () => {
    assert.deepEqual(decide({ verdict: collapsed, current: "pending", above: true }), { sift: null, label: null, send: false, defer: true });
    assert.deepEqual(decide({ verdict: collapsed, current: null, deferred: true }), { sift: null, label: null, send: false, defer: false });
});

test("a post that failed before is asked again open, not blurred", () => {
    assert.deepEqual(decide({ retried: true }), { sift: null, label: null, send: true, defer: false });
    assert.deepEqual(decide({ retried: true, inFlight: true }), { sift: null, label: null, send: false, defer: false });
    assert.deepEqual(decide({ retried: true, coolingDown: true }), { sift: null, label: null, send: false, defer: false });
});

test("a late collapse on a post shown open while it's asked again waits for X to remount it, wherever it is", () => {
    for (const above of [true, false]) {
        assert.deepEqual(decide({ verdict: collapsed, current: null, waitingOpen: true, above }), { sift: null, label: null, send: false, defer: true }, String(above));
    }
});

test("a post that failed once and was judged since collapses on a fresh mount, even above the viewport", () => {
    assert.deepEqual(decide({ verdict: collapsed, current: null, retried: true, above: true }), { sift: "collapsed", label: "Rage bait 0.90", send: false, defer: false });
    assert.deepEqual(decide({ verdict: collapsed, current: "collapsed", retried: true, waitingOpen: true }), { sift: "collapsed", label: "Rage bait 0.90", send: false, defer: false });
});

test("an open verdict clears the mark", () => {
    assert.deepEqual(decide({ verdict: open, current: "pending" }), { sift: null, label: null, send: false, defer: false });
});

test("a post you opened with Show stays open", () => {
    assert.deepEqual(decide({ verdict: collapsed, current: "collapsed", peeked: true }), { sift: null, label: null, send: false, defer: false });
});

test("a reused cell drops the previous post's bar and waits for its own answer", () => {
    assert.deepEqual(decide({ current: "collapsed" }), { sift: "pending", label: null, send: true, defer: false });
});

test("only Jev's own scores teach; a post you already corrected teaches nothing", () => {
    const scores = { bait: 0.96, rage: 0.2, low: 0.96, promo: 0.04 };
    assert.equal(learnableScores({ scores }), scores);
    assert.equal(learnableScores({ scores, byYou: "hide" }), undefined);
    assert.equal(learnableScores({ tooLittle: true }), undefined);
    assert.equal(learnableScores(undefined), undefined);
});

test("an author you always show: the answer is just that, and it teaches nothing", () => {
    assert.deepEqual(replyOf({ id: "1", trusted: true }), { seen: null, told: false, answer: { trusted: true }, coolDown: false, until: null });
    assert.deepEqual(replyOf({ id: "1", trusted: true, seen: 5 }), { seen: 5, told: false, answer: { trusted: true }, coolDown: false, until: null });
    assert.equal(learnableScores({ trusted: true }), undefined);
});

test("scores judged with a photo don't teach yet: they run higher on bait than the text-only scores the thresholds learned", () => {
    const scores = { bait: 0.85, rage: 0.2, low: 0.3, promo: 0.04 };
    assert.equal(learnableScores({ scores, photo: true }), undefined);
    assert.deepEqual(replyOf({ id: "1", scores, photo: true }), { seen: null, told: false, answer: { scores, photo: true }, coolDown: false, until: null });
});

test("a post cooling down after a failure is shown and not sent", () => {
    assert.deepEqual(decide({ current: "pending", coolingDown: true }), { sift: null, label: null, send: false, defer: false });
});

test("the post you're on stays open when a late collapse arrives, until X remounts it", () => {
    assert.deepEqual(decide({ verdict: collapsed, current: "pending", held: true }), { sift: null, label: null, send: false, defer: true });
    assert.deepEqual(decide({ verdict: collapsed, current: null, held: true }), { sift: null, label: null, send: false, defer: true });
    // Focus on a bar's own button doesn't reopen it.
    assert.deepEqual(decide({ verdict: collapsed, current: "collapsed", held: true }), { sift: "collapsed", label: "Rage bait 0.90", send: false, defer: false });
});

// j and k: cells in page order, open or not, with their tops; the header's bottom edge is at 53.
const at = (...rows) => rows.map(([open, top]) => ({ open, top }));

test("j and k skip bars and the replies hidden with them", () => {
    const cells = at([true, 52], [false, 400], [false, 430], [true, 460], [false, 900]);
    assert.equal(pick(cells, 0, 1, 53), 3);
    assert.equal(pick(cells, 3, -1, 53), 0);
});

test("j and k find nothing when no open post is loaded that way", () => {
    const cells = at([true, 52], [false, 400], [false, 430]);
    assert.equal(pick(cells, 0, 1, 53), -1);
    assert.equal(pick(cells, 0, -1, 53), -1);
});

test("with no post selected, j starts at the first post under the header and k at the one above it", () => {
    const cells = at([true, -300], [false, 20], [true, 30], [false, 80], [true, 120], [true, 600]);
    assert.equal(pick(cells, -1, 1, 53), 4);
    assert.equal(pick(cells, -1, -1, 53), 2);
    assert.equal(pick(at([true, 52]), -1, 1, 53), 0); // where X's own j leaves a post
});

// Focus mode: the header's bottom edge at 53 in a window 900 tall puts the reading line at 53 + 847 / 3 ≈ 335.33.
const LINE = readingLine(53, 900);

test("the reading line is a third of the way down under the header", () => {
    assert.equal(Math.round(LINE), 335);
});

test("a long post ends, going down, when its end rises into the top third", () => {
    const edges = exitEdges({ top: 52, bottom: 1400 }, LINE, 53);
    assert.deepEqual(edges, { down: LINE, up: LINE + 48 });
    assert.equal(readOn({ top: -700, bottom: 400 }, edges, 1), 0);
    assert.equal(readOn({ top: -1100, bottom: 300 }, edges, 1), 1);
});

test("a short post reached with j stays current until it scrolls out of the top", () => {
    const edges = exitEdges({ top: 52, bottom: 153 }, LINE, 53); // its bottom is already above the line
    assert.deepEqual(edges, { down: 53, up: LINE + 48 });
    assert.equal(readOn({ top: 2, bottom: 103 }, edges, 1), 0);
    assert.equal(readOn({ top: -60, bottom: 41 }, edges, 1), 1);
});

test("scrolling up on a short post never moves forward, and goes back only past the line", () => {
    const edges = exitEdges({ top: 52, bottom: 153 }, LINE, 53);
    assert.equal(readOn({ top: 92, bottom: 193 }, edges, -1), 0);
    assert.equal(readOn({ top: -60, bottom: 41 }, edges, -1), 0); // past the down edge, but scrolling up
    assert.equal(readOn({ top: 400, bottom: 501 }, edges, -1), -1); // 48 px past the line
});

test("a small reversal at a hand-over doesn't flip back", () => {
    const edges = exitEdges({ top: LINE - 5, bottom: LINE + 400 }, LINE, 53); // just became current going down
    assert.equal(readOn({ top: LINE + 20, bottom: LINE + 425 }, edges, -1), 0);
    assert.equal(readOn({ top: LINE + 50, bottom: LINE + 455 }, edges, -1), -1);
});

test("a post that became current below the line goes back 48 px further down", () => {
    const edges = exitEdges({ top: 500, bottom: 900 }, LINE, 53); // reached across a gap: a hidden bar or Who to follow
    assert.deepEqual(edges, { down: LINE, up: 548 });
    assert.equal(readOn({ top: 520, bottom: 920 }, edges, -1), 0);
    assert.equal(readOn({ top: 560, bottom: 960 }, edges, -1), -1);
});

test("a scroll down never goes back", () => {
    // Its top is past the up edge (383.33), but the scroll is downward.
    assert.equal(readOn({ top: 400, bottom: 800 }, exitEdges({ top: 300, bottom: 700 }, LINE, 53), 1), 0);
});

// focusPick: cells in page order as [open, top, bottom].
const boxes = (...rows) => rows.map(([open, top, bottom]) => ({ open, top, bottom }));

test("turning focus on keeps the post you're on when it's at the top", () => {
    assert.equal(focusPick(boxes([true, -400, 52], [true, 52, 200], [true, 200, 700]), 1, LINE, 53, 900), 1);
});

test("otherwise focus mode starts on the open post across the reading line", () => {
    const cells = boxes([true, -400, 100], [false, 100, 140], [true, 140, 700]);
    assert.equal(focusPick(cells, 0, LINE, 53, 900), 2); // the post you were on has scrolled up
    assert.equal(focusPick(cells, -1, LINE, 53, 900), 2);
});

test("with a bar across the line, the first open post on screen under the header; with none, nothing", () => {
    assert.equal(focusPick(boxes([true, -400, 52], [false, 300, 340], [true, 340, 700]), -1, LINE, 53, 900), 2);
    assert.equal(focusPick(boxes([true, -400, 52], [false, 52, 950]), -1, LINE, 53, 900), -1);
});

test("at the top, or after a jump there, the first post under the header, even a short one", () => {
    const cells = boxes([true, 60, 160], [true, 160, 700]);
    assert.equal(focusPick(cells, -1, LINE, 53, 900, true), 0);
    assert.equal(focusPick(cells, -1, LINE, 53, 900), 1); // across the line would have skipped it
});

// Seen posts on Home: a cell's time and place are taken when it starts holding the post.
const cell = { at: 1000, ahead: true };

test("a post you saw before it showed up ahead of you is skipped", () => {
    assert.equal(skipSeen({ ...cell, seenAt: 500 }), true);
    assert.equal(skipSeen({ ...cell, ahead: false, seenAt: 500 }), false); // above the screen, as you scroll back up
    assert.equal(skipSeen({ ...cell, seenAt: undefined }), false);
});

test("a post you read in this very cell doesn't collapse under you", () => {
    assert.equal(skipSeen({ ...cell, seenAt: 1500 }), false);
});

test("a post skipped once stays skipped, even above the screen", () => {
    assert.equal(skipSeen({ ...cell, ahead: false, seenAt: 1500, before: true }), true);
});

test("the post you're on and the post you left are never skipped", () => {
    assert.equal(skipSeen({ ...cell, seenAt: 500, held: true }), false);
    assert.equal(skipSeen({ ...cell, seenAt: 500, left: true }), false);
});

test("a Seen bar shows the time today, else the date", () => {
    const now = new Date(2026, 9, 15, 18, 0).getTime();
    assert.equal(seenLabel(new Date(2026, 9, 15, 17, 25).getTime(), now, "en-US"), "Seen 5:25 PM");
    assert.equal(seenLabel(new Date(2026, 9, 13, 9, 0).getTime(), now, "en-US"), "Seen Oct 13");
    assert.equal(seenLabel(new Date(2025, 11, 31, 9, 0).getTime(), now, "en-US"), "Seen Dec 31, 2025");
});

test("visible time adds up only while counting", () => {
    let s = { ms: 0, since: null };
    s = tally(s, true, 1000); // starts counting
    assert.deepEqual(s, { ms: 0, since: 1000 });
    s = tally(s, false, 1600); // the tab is hidden, or the post blurred
    assert.deepEqual(s, { ms: 600, since: null });
    s = tally(s, true, 9000); // nothing added while paused
    assert.deepEqual(s, { ms: 600, since: 9000 });
    s = tally(s, true, 9400);
    assert.equal(s.ms >= SEEN_MS, true);
});

test("0.9 s isn't enough", () => {
    assert.equal(tally({ ms: 0, since: 0 }, false, 900).ms < SEEN_MS, true);
});

// With focus mode off: the header's bottom at 53, a window 900 tall (a timeline of 847, half 423.5).
test("a short post is on screen to read only when all of it is", () => {
    assert.equal(readable({ top: 60, bottom: 300 }, 53, 900), true);
    assert.equal(readable({ top: 40, bottom: 300 }, 53, 900), false); // under the header
    assert.equal(readable({ top: 700, bottom: 950 }, 53, 900), false); // past the bottom
});

test("a tall post counts while it covers half the timeline", () => {
    assert.equal(readable({ top: -600, bottom: 600 }, 53, 900), true); // 547 of 847
    assert.equal(readable({ top: -900, bottom: 400 }, 53, 900), false); // 347 of 847
});

// What a judge reply means for this tab. A failed judge cools down even when the post is in the Seen list,
// or the tab would ask again every frame.
test("a reply that's only 'seen' keeps no answer, doesn't cool down, and stops Home asking again", () => {
    assert.deepEqual(replyOf({ id: "1", seen: 5 }), { seen: 5, told: true, answer: null, coolDown: false, until: null });
});

test("a failed judge cools down, also for a post you've seen", () => {
    assert.deepEqual(replyOf({ id: "1", error: true, seen: 5 }), { seen: 5, told: false, answer: null, coolDown: true, until: null });
    assert.deepEqual(replyOf({ id: "1", error: true }), { seen: null, told: false, answer: null, coolDown: true, until: null });
    assert.deepEqual(replyOf(undefined), { seen: null, told: false, answer: null, coolDown: true, until: null });
});

test("a judge paused by the spending limit cools down until it resumes, and isn't taken as only 'seen'", () => {
    assert.deepEqual(replyOf({ id: "1", paused: 1000 }), { seen: null, told: false, answer: null, coolDown: true, until: 1000 });
    assert.deepEqual(replyOf({ id: "1", paused: 1000, seen: 5 }), { seen: 5, told: false, answer: null, coolDown: true, until: 1000 });
});

test("a verdict with a seen time keeps both", () => {
    const scores = { bait: 0.1, rage: 0, low: 0, promo: 0 };
    assert.deepEqual(replyOf({ id: "1", scores, seen: 5 }), { seen: 5, told: false, answer: { scores }, coolDown: false, until: null });
    assert.deepEqual(replyOf({ id: "1", byYou: "hide" }), { seen: null, told: false, answer: { byYou: "hide" }, coolDown: false, until: null });
    assert.deepEqual(replyOf({ id: "1", tooLittle: true }), { seen: null, told: false, answer: { tooLittle: true }, coolDown: false, until: null });
});

// Ahead of you: under X's header (53 here), and in line with the neighbours' tops in X's order (null at an end).
test("the newest post at the top, and posts loaded below, are ahead", () => {
    assert.equal(aheadAt(null, 53, 600, 53), true); // first cell after a reload
    assert.equal(aheadAt(1200, 1700, null, 53), true); // appended below while you scroll down
    assert.equal(aheadAt(300, 300, 700, 53), true); // a neighbour at the same top
});

test("a cell above the header, or out of line with its neighbours, isn't ahead", () => {
    assert.equal(aheadAt(-400, 20, 300, 53), false); // under the header
    assert.equal(aheadAt(null, 266, -2000, 53), false); // inserted at the top while you're scrolled down
    assert.equal(aheadAt(-1000, 266, -700, 53), false); // shown for a frame between two cells above you
});

// Focus mode's seen rule, one check at a time: the current post's id, whether the tab is visible, whether you've
// touched the page since it loaded, and whether the post is open (not blurred or collapsed).
const on = (id, over = {}) => ({ id, visible: true, touched: true, open: true, ...over });
const fresh = { id: null, ms: 0, since: null };

test("focus mode: 1 s as the current post records it, once", () => {
    let s = focusStep(fresh, on("A"), 0);
    assert.equal(s.record, false);
    assert.equal(s.wait, SEEN_MS);
    s = focusStep(s.watch, on("A"), 1000);
    assert.equal(s.record, true);
    assert.equal(focusStep(s.watch, on("A"), 5000).record, false); // once per stay
});

test("focus mode: 0.9 s and then k doesn't record it", () => {
    let s = focusStep(fresh, on("A"), 0);
    s = focusStep(s.watch, on("A"), 900);
    s = focusStep(s.watch, on("B"), 900); // k moved to B
    assert.equal(s.record, false);
    s = focusStep(s.watch, on("A"), 1000); // back on A: it starts again from 0
    assert.equal(focusStep(s.watch, on("A"), 1900).record, false);
});

test("focus mode: nothing counts before your first input", () => {
    let s = focusStep(fresh, on("A", { touched: false }), 0);
    s = focusStep(s.watch, on("A", { touched: false }), 3000);
    assert.equal(s.record, false);
    assert.equal(s.wait, null);
    s = focusStep(s.watch, on("A"), 3000); // your first key
    assert.equal(focusStep(s.watch, on("A"), 3900).record, false);
    assert.equal(focusStep(s.watch, on("A"), 4000).record, true);
});

test("focus mode: time with the tab hidden or the post blurred doesn't count", () => {
    for (const over of [{ visible: false }, { open: false }]) {
        let s = focusStep(fresh, on("A"), 0);
        s = focusStep(s.watch, on("A", over), 500); // 0.5 s counted, then paused
        s = focusStep(s.watch, on("A", over), 9000);
        assert.equal(s.record, false, JSON.stringify(over));
        s = focusStep(s.watch, on("A"), 9000);
        assert.equal(focusStep(s.watch, on("A"), 9400).record, false);
        assert.equal(focusStep(s.watch, on("A"), 9500).record, true);
    }
});

// Focus mode off, one post at a time: the header's bottom at 53, a window 900 tall.
const shown = { top: 100, bottom: 400 }, gone = { top: -300, bottom: 0 }, below = { top: 950, bottom: 1200 };

test("focus mode off: a post that scrolls off the top after 1 s on screen records it", () => {
    let s = passStep(undefined, shown, 53, 900, true, 0);
    s = passStep(s.state, shown, 53, 900, true, 1000);
    s = passStep(s.state, gone, 53, 900, true, 1100);
    assert.deepEqual(s, { state: null, record: true });
});

test("focus mode off: 0.9 s on screen, or time with the tab hidden, doesn't record it", () => {
    let s = passStep(undefined, shown, 53, 900, true, 0);
    assert.equal(passStep(s.state, gone, 53, 900, true, 900).record, false);
    s = passStep(undefined, shown, 53, 900, false, 0); // hidden tab, or a blurred post
    s = passStep(s.state, shown, 53, 900, false, 5000);
    assert.equal(passStep(s.state, gone, 53, 900, true, 5100).record, false);
});

test("focus mode off: a post taller than half the timeline counts while it covers half", () => {
    let s = passStep(undefined, { top: -300, bottom: 700 }, 53, 900, true, 0); // 647 of 847
    s = passStep(s.state, { top: -800, bottom: 40 }, 53, 900, true, 1200);
    assert.equal(s.record, true);
    s = passStep(undefined, { top: -900, bottom: 400 }, 53, 900, true, 0); // 347 of 847: not to read
    assert.equal(passStep(s.state, gone, 53, 900, true, 2000).record, false);
});

test("focus mode off: a post below the window is forgotten", () => {
    assert.deepEqual(passStep({ ms: 800, since: 0 }, below, 53, 900, true, 100), { state: null, record: false });
});

test("j records the post it leaves, but not on a repeat or with no start post", () => {
    assert.equal(jRecords(1, false, true), true);
    assert.equal(jRecords(1, true, true), false); // j held down
    assert.equal(jRecords(1, false, false), false); // no post to start from
    assert.equal(jRecords(-1, false, true), false); // k
});

test("a reply sent before you cleared the Seen list forgets its seen time and asks again", () => {
    assert.deepEqual(replyOf({ id: "1", seen: 5 }, true), { seen: null, told: false, answer: null, coolDown: false, until: null });
    const scores = { bait: 0.1, rage: 0, low: 0, promo: 0 };
    assert.deepEqual(replyOf({ id: "1", scores, seen: 5 }, true), { seen: null, told: false, answer: { scores }, coolDown: false, until: null });
});

test("the author's name and handle, with an @ in the display name", () => {
    assert.deepEqual(userParts("Ana B@ana_b·5h"), { name: "Ana B", handle: "ana_b" });
    assert.deepEqual(userParts("Ana @ana_bsky@realone·5h"), { name: "Ana @ana_bsky", handle: "realone" });
    assert.deepEqual(userParts("Ana @ana_bsky@realone·5h", "realone"), { name: "Ana @ana_bsky", handle: "realone" });
    assert.deepEqual(userParts(""), { name: "", handle: "" });
});

test("a Seen bar's time and date follow the same locale", () => {
    const now = new Date(2026, 9, 15, 18, 0).getTime();
    assert.equal(seenLabel(new Date(2026, 9, 15, 17, 25).getTime(), now, "en-GB"), "Seen 17:25");
    assert.equal(seenLabel(new Date(2026, 9, 13, 9, 0).getTime(), now, "en-GB"), "Seen 13 Oct");
});

test("an image description counts unless it's 12 characters or fewer, like X's default label in any language", () => {
    for (const alt of ["Image", "Bild", "Imagen", "画像", "Изображение", "Hình ảnh", "Afbeelding", "", "  "]) assert.equal(described(alt), false, alt);
    for (const alt of ["A cat asleep on a keyboard", "Screenshot of the release notes", "Supercalifragilistic"]) assert.equal(described(alt), true, alt);
});
