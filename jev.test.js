// Checks Xift's Jev request shape and how every kind of response is classified.
const test = require("node:test");
const assert = require("node:assert/strict");
const Jev = require("./jev.js");

const post = { author: "Ana", handle: "@ana", text: "Rust 1.95 ships faster incremental builds", quoted: "", alt: "" };
const asAnswers = (s) => Object.fromEntries(Object.entries(s).map(([key, p]) => [key, { type: "noul", noul: p }]));
const scores = { bait: 0.96, rage: 0.21, low: 0.96, promo: 0.04 };
// Shaped like a real 2026-10-14 response.
const okBody = { model: "typesafe/jev-1.13-20260917", answers: asAnswers(scores), usage: { input_tokens: 605, output_tokens: 70, cost: 0.0000254 } };

test("the request asks four yes/no questions about the post alone", () => {
    const body = Jev.buildRequest(post);
    assert.equal(body.model, "typesafe/jev-1.13-20260917");
    assert.deepEqual(body.provider, { data_collection: "deny" });
    assert.deepEqual(body.state, { post });
    assert.deepEqual(Object.keys(body.questions), ["bait", "rage", "low", "promo"]);
    for (const q of Object.values(body.questions)) {
        assert.equal(q.type, "noul");
        assert.deepEqual(Object.keys(q.criteria), ["true", "false"]);
    }
});

test("capPost keeps known fields as capped strings", () => {
    const capped = Jev.capPost({ text: "a".repeat(2500), quoted: 7, author: undefined, evil: "<script>" });
    assert.equal(capped.text.length, 2000);
    assert.equal(capped.quoted, "7");
    assert.equal(capped.author, "");
    assert.equal(capped.handle, "");
    assert.equal(capped.alt, "");
    assert.equal("evil" in capped, false);
});

test("capPost never cuts an emoji in half", () => {
    assert.ok(Jev.capPost({ text: "a".repeat(1999) + "😀" }).text.isWellFormed());
});

test("a good 200 is ok", () => {
    assert.deepEqual(Jev.classify(200, okBody, null), { ok: true, scores, cost: 0.0000254, model: "typesafe/jev-1.13-20260917" });
});

test("missing usage.cost is unknown cost, not a failure", () => {
    const { usage, ...noUsage } = okBody;
    assert.deepEqual(Jev.classify(200, noUsage, null), { ok: true, scores, cost: null, model: okBody.model });
});

test("malformed 200 responses are temporary failures", () => {
    const broken = [
        null,
        { error: { code: 500, message: "upstream" } },
        { answers: asAnswers({ bait: 0.1, rage: 0.1, low: 0.1 }) }, // promo missing
        { answers: asAnswers({ ...scores, rage: 1.2 }) },
        { answers: { ...asAnswers(scores), low: { type: "score", noul: 0.2 } } },
    ];
    for (const body of broken) {
        assert.deepEqual(Jev.classify(200, body, null), { ok: false, kind: "temporary", status: 200, retryAfterMs: null }, JSON.stringify(body));
    }
});

test("no response, timeouts, rate limits and server errors are temporary", () => {
    for (const status of [0, 408, 429, 500, 502, 503, 524, 529]) assert.equal(Jev.classify(status, null, null).kind, "temporary", String(status));
    assert.equal(Jev.classify(429, null, "5").retryAfterMs, 5000);
});

test("402 from the in-flight budget is temporary", () => {
    const body = { error: { code: 402, message: "Too many requests in flight", metadata: { limit_source: "openrouter_in_flight_budget" } } };
    assert.equal(Jev.classify(402, body, "2").kind, "temporary");
});

test("402 from a spent limit is permanent", () => {
    const body = { error: { code: 402, message: "Key limit exceeded", metadata: { limit_source: "openrouter_key_limit" } } };
    assert.equal(Jev.classify(402, body, null).kind, "permanent");
});

test("a refused or bad request fails only that post", () => {
    for (const status of [400, 403]) assert.equal(Jev.classify(status, { error: { code: status, message: "x" } }, null).kind, "post", String(status));
});

test("a bad key or an unexpected status stops everything", () => {
    for (const status of [401, 404]) assert.equal(Jev.classify(status, { error: { code: status, message: "x" } }, null).kind, "permanent", String(status));
    assert.equal(Jev.classify(404, { error: { code: 404, message: "No endpoints found for typesafe/jev-1.13" } }, null).message, "No endpoints found for typesafe/jev-1.13");
});

test("Retry-After accepts seconds and HTTP dates", () => {
    const now = Date.parse("2026-10-13T12:00:00Z");
    assert.equal(Jev.parseRetryAfter("5", now), 5000);
    assert.equal(Jev.parseRetryAfter("Tue, 13 Oct 2026 12:00:10 GMT", now), 10000);
    assert.equal(Jev.parseRetryAfter("soon", now), null);
    assert.equal(Jev.parseRetryAfter(null, now), null);
});

test("backoff is 1 s then 3 s, longer if Retry-After says so, never above 10 s", () => {
    assert.equal(Jev.backoffMs(0, null), 1000);
    assert.equal(Jev.backoffMs(1, null), 3000);
    assert.equal(Jev.backoffMs(0, 5000), 5000);
    assert.equal(Jev.backoffMs(1, 60000), 10000);
});

// Today's text-only request, written out (0.5.x): photo support must leave it exactly as it is, or the thresholds you
// taught Xift would no longer mean the same thing.
const TEXT_REQUEST = {"model": "typesafe/jev-1.13-20260917", "provider": {"data_collection": "deny"}, "state": {"post": {"author": "Ana", "handle": "@ana", "text": "Rust 1.95 ships faster incremental builds", "quoted": "", "alt": ""}}, "questions": {"bait": {"type": "noul", "instructions": "Does `post.text` mainly fish for likes, reposts, replies or follows?", "criteria": {"true": "`post.text` mainly fishes for likes, reposts, replies or follows.", "false": "`post.text` does not mainly fish for likes, reposts, replies or follows."}}, "rage": {"type": "noul", "instructions": "Is `post.text` mainly written to provoke anger or outrage?", "criteria": {"true": "`post.text` is mainly written to provoke anger or outrage.", "false": "`post.text` is not mainly written to provoke anger or outrage."}}, "low": {"type": "noul", "instructions": "Does `post.text` share little real information, ideas or experience?", "criteria": {"true": "`post.text` is mostly filler, vague hype or an empty one-liner.", "false": "`post.text` shares real information, an idea or an experience."}}, "promo": {"type": "noul", "instructions": "Is `post.text` mainly promoting something to sell or sign up for, such as a product, course, newsletter or giveaway?", "criteria": {"true": "`post.text` mainly promotes something to sell or sign up for.", "false": "`post.text` does not mainly promote something to sell or sign up for."}}}};

test("a post sent without a photo asks exactly what it asked before photos", () => {
    assert.deepEqual(Jev.buildRequest(post), TEXT_REQUEST);
    assert.deepEqual(Jev.buildRequest(post, null), TEXT_REQUEST);
});

test("with a photo, the photo goes along and every question names it once", () => {
    const image = "data:image/jpeg;base64,/9j/AAAA";
    const body = Jev.buildRequest(post, image);
    assert.deepEqual(body.state, { post: { ...post, images: [{ type: "image_url", image_url: { url: image } }] } });
    assert.equal(body.model, TEXT_REQUEST.model);
    assert.equal(body.questions.bait.instructions, "Does the post (`post.text` and `post.images`) mainly fish for likes, reposts, replies or follows?");
    assert.equal(body.questions.bait.criteria.true, "The post (`post.text` and `post.images`) mainly fishes for likes, reposts, replies or follows.");
    for (const [key, q] of Object.entries(body.questions)) {
        for (const s of [q.instructions, q.criteria.true, q.criteria.false]) {
            assert.equal(s.match(/post\.images/g)?.length, 1, `${key}: ${s}`);
            assert.ok(!s.includes("(the post (") && !s.includes("(The post ("), `${key}: ${s}`);
        }
        // Apart from naming the photo, the same question as without one.
        const same = (s) => s.replace("The post (`post.text` and `post.images`)", "`post.text`").replace("the post (`post.text` and `post.images`)", "`post.text`");
        assert.deepEqual([same(q.instructions), same(q.criteria.true), same(q.criteria.false)],
            [TEXT_REQUEST.questions[key].instructions, TEXT_REQUEST.questions[key].criteria.true, TEXT_REQUEST.questions[key].criteria.false]);
    }
});

test("only X's own photo URLs pass, as the small JPEG", () => {
    assert.equal(Jev.photoUrl("https://pbs.twimg.com/media/HUvWb9oXgAAHtrk?format=webp&name=120x120"), "https://pbs.twimg.com/media/HUvWb9oXgAAHtrk?format=jpg&name=small");
    assert.equal(Jev.photoUrl("https://pbs.twimg.com/media/HUvWb9o-XgA_Htrk.jpg"), "https://pbs.twimg.com/media/HUvWb9o-XgA_Htrk?format=jpg&name=small");
    for (const bad of ["http://pbs.twimg.com/media/X", "https://pbs.twimg.com.evil.com/media/X", "https://pbs.twimg.com/amplify_video_thumb/1/img/X", "https://abs.twimg.com/media/X",
        "https://pbs.twimg.com/media/", "https://evil.com/?u=https://pbs.twimg.com/media/X", "", null, 7]) assert.equal(Jev.photoUrl(bad), null, String(bad));
});

test("a photo fits Jev's 280 to 1,568 px: shrunk if too big, padded if too thin, never stretched", () => {
    assert.deepEqual(Jev.imageBox(680, 516), { w: 680, h: 516, x: 0, y: 0, dw: 680, dh: 516 });
    assert.deepEqual(Jev.imageBox(836, 182), { w: 836, h: 280, x: 0, y: 49, dw: 836, dh: 182 }); // the spike's thin photo
    assert.deepEqual(Jev.imageBox(100, 50), { w: 280, h: 280, x: 90, y: 115, dw: 100, dh: 50 });
    assert.deepEqual(Jev.imageBox(3136, 1000), { w: 1568, h: 500, x: 0, y: 0, dw: 1568, dh: 500 });
    assert.deepEqual(Jev.imageBox(6000, 300), { w: 1568, h: 280, x: 0, y: 101, dw: 1568, dh: 78 });
});

test("a refused request keeps Jev's reason, cut short", () => {
    assert.equal(Jev.classify(400, { error: { message: "Invalid image dimensions." } }).message, "Invalid image dimensions.");
    assert.equal(Jev.classify(400, { error: { message: "x".repeat(500) } }).message.length, 200);
    assert.equal(Jev.classify(400, null).message, "");
});

test("a local request goes to Ollama's model, with no OpenRouter fields", () => {
    const body = Jev.buildRequest(post, null, "nimble");
    assert.equal(body.model, "nimble");
    assert.equal("provider" in body, false);
    assert.equal("images" in body, false);
    assert.deepEqual(body.state, { post });
    assert.deepEqual(body.questions, Jev.buildRequest(post).questions);
});

test("a local photo goes as bare base64 beside the state, and the questions name it", () => {
    const body = Jev.buildRequest(post, "data:image/jpeg;base64,/9j/AAAA", "clef-flash");
    assert.deepEqual(body.images, ["/9j/AAAA"]);
    assert.deepEqual(body.state, { post });
    for (const q of Object.values(body.questions)) {
        assert.match(q.instructions, /the attached photo/);
        assert.doesNotMatch(JSON.stringify(q), /post\.images/);
    }
});

test("only the Clef models read photos locally", () => {
    for (const m of ["clef", "clef-flash", "clef:latest", "clef-flash:q8_0"]) assert.equal(Jev.readsImages(m), true, m);
    for (const m of ["nimble", "tev1:4b", "kev", "notclef"]) assert.equal(Jev.readsImages(m), false, m);
});

test("Ollama's 403 means it refuses the add-on, which stops everything with the fix", () => {
    const r = Jev.classify(403, null, null, true);
    assert.equal(r.kind, "permanent");
    assert.match(r.message, /OLLAMA_ORIGINS/);
});

test("a model Ollama hasn't pulled stops everything, with Ollama's reason", () => {
    const r = Jev.classify(404, { error: 'model "nimble" not found, try pulling it first' }, null, true);
    assert.equal(r.kind, "permanent");
    assert.equal(r.message, 'model "nimble" not found, try pulling it first');
});

test("a local answer is ok with no cost", () => {
    const r = Jev.classify(200, { model: "nimble", answers: asAnswers(scores), usage: { input_tokens: 792, output_tokens: 0 } }, null, true);
    assert.deepEqual(r, { ok: true, scores, cost: null, model: "nimble" });
});

test("Ollama's own failures are retried, with its reason kept for the status line", () => {
    const r = Jev.classify(500, { error: "model requires 11.5 GiB but only 11.3 GiB are available (after 512.0 MiB overhead)" }, null, true);
    assert.equal(r.kind, "temporary");
    assert.match(r.message, /requires 11.5 GiB/);
});
