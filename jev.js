// Builds Jev requests, with the post's first photo when it has one, and checks Jev responses. No browser APIs, so the
// Node tests cover all of it.
// A classic script: the background page loads it before background.js.
(() => {
    const ENDPOINT = "https://openrouter.ai/api/v1/systemone";
    const MODEL = "typesafe/jev-1.13-20260917";
    // Ollama on this computer, which answers the same request shape (v0.35+). 127.0.0.1, not localhost: it listens on IPv4.
    const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1/systemone";
    const CAPS = { author: 100, handle: 100, text: 2000, quoted: 1000, alt: 500 };
    const BACKOFF_MS = [1000, 3000];
    const MAX_BACKOFF_MS = 10_000;
    // [instructions, true criterion, false criterion], worded after the 2026-10-14 calibration run.
    // The keys match SiftVerdict.QUALITIES.
    const QUESTIONS = {
        bait: [
            "Does `post.text` mainly fish for likes, reposts, replies or follows?",
            "`post.text` mainly fishes for likes, reposts, replies or follows.",
            "`post.text` does not mainly fish for likes, reposts, replies or follows.",
        ],
        rage: [
            "Is `post.text` mainly written to provoke anger or outrage?",
            "`post.text` is mainly written to provoke anger or outrage.",
            "`post.text` is not mainly written to provoke anger or outrage.",
        ],
        low: [
            "Does `post.text` share little real information, ideas or experience?",
            "`post.text` is mostly filler, vague hype or an empty one-liner.",
            "`post.text` shares real information, an idea or an experience.",
        ],
        promo: [
            "Is `post.text` mainly promoting something to sell or sign up for, such as a product, course, newsletter or giveaway?",
            "`post.text` mainly promotes something to sell or sign up for.",
            "`post.text` does not mainly promote something to sell or sign up for.",
        ],
    };

    // The same questions when a photo goes along, naming it: without that, Jev judges the text alone (2026-10-15 spike,
    // re-run 2026-10-16). Written out rather than derived: the spike's first rename renamed twice and garbled them.
    const PHOTO_QUESTIONS = {
        bait: [
            "Does the post (`post.text` and `post.images`) mainly fish for likes, reposts, replies or follows?",
            "The post (`post.text` and `post.images`) mainly fishes for likes, reposts, replies or follows.",
            "The post (`post.text` and `post.images`) does not mainly fish for likes, reposts, replies or follows.",
        ],
        rage: [
            "Is the post (`post.text` and `post.images`) mainly written to provoke anger or outrage?",
            "The post (`post.text` and `post.images`) is mainly written to provoke anger or outrage.",
            "The post (`post.text` and `post.images`) is not mainly written to provoke anger or outrage.",
        ],
        low: [
            "Does the post (`post.text` and `post.images`) share little real information, ideas or experience?",
            "The post (`post.text` and `post.images`) is mostly filler, vague hype or an empty one-liner.",
            "The post (`post.text` and `post.images`) shares real information, an idea or an experience.",
        ],
        promo: [
            "Is the post (`post.text` and `post.images`) mainly promoting something to sell or sign up for, such as a product, course, newsletter or giveaway?",
            "The post (`post.text` and `post.images`) mainly promotes something to sell or sign up for.",
            "The post (`post.text` and `post.images`) does not mainly promote something to sell or sign up for.",
        ],
    };

    // Ollama takes a photo beside the state, not in it, so these name "the attached photo". Written out, as above.
    const LOCAL_PHOTO_QUESTIONS = {
        bait: [
            "Does the post (`post.text` and the attached photo) mainly fish for likes, reposts, replies or follows?",
            "The post (`post.text` and the attached photo) mainly fishes for likes, reposts, replies or follows.",
            "The post (`post.text` and the attached photo) does not mainly fish for likes, reposts, replies or follows.",
        ],
        rage: [
            "Is the post (`post.text` and the attached photo) mainly written to provoke anger or outrage?",
            "The post (`post.text` and the attached photo) is mainly written to provoke anger or outrage.",
            "The post (`post.text` and the attached photo) is not mainly written to provoke anger or outrage.",
        ],
        low: [
            "Does the post (`post.text` and the attached photo) share little real information, ideas or experience?",
            "The post (`post.text` and the attached photo) is mostly filler, vague hype or an empty one-liner.",
            "The post (`post.text` and the attached photo) shares real information, an idea or an experience.",
        ],
        promo: [
            "Is the post (`post.text` and the attached photo) mainly promoting something to sell or sign up for, such as a product, course, newsletter or giveaway?",
            "The post (`post.text` and the attached photo) mainly promotes something to sell or sign up for.",
            "The post (`post.text` and the attached photo) does not mainly promote something to sell or sign up for.",
        ],
    };

    // Whether a local model reads photos. ponytail: by name, the Clef family only; ask Ollama's /api/show if more appear.
    const readsImages = (model) => /^clef(-|:|$)/.test(String(model));

    // A photo on X's image server, as the JPEG at X's small size (at most 680 px), or null: only the media ID is kept
    // from the page's URL. X serves WebP by default, which Jev rejects.
    function photoUrl(raw) {
        const id = typeof raw === "string" && raw.length <= 512 ? raw.match(/^https:\/\/pbs\.twimg\.com\/media\/([\w-]+)(?=[.?]|$)/)?.[1] : null;
        return id ? `https://pbs.twimg.com/media/${id}?format=jpg&name=small` : null;
    }

    // Where a w × h photo goes on the canvas sent to Jev, which reads 280 to 1,568 px per side (279 is refused, though
    // its docs say 256): a bigger photo is shrunk, a thinner one padded, never stretched.
    function imageBox(w, h) {
        const s = Math.min(1, 1568 / Math.max(w, h));
        const dw = Math.round(w * s);
        const dh = Math.round(h * s);
        const W = Math.max(dw, 280);
        const H = Math.max(dh, 280);
        return { w: W, h: H, x: Math.floor((W - dw) / 2), y: Math.floor((H - dh) / 2), dw, dh };
    }

    // The post comes from a web page: keep only known fields, as strings, within the caps.
    function capPost(post) {
        const out = {};
        for (const [field, max] of Object.entries(CAPS)) out[field] = String(post?.[field] ?? "").slice(0, max).toWellFormed(); // never half an emoji
        return out;
    }

    // image: the photo as a JPEG data URL, or null for text only, which asks exactly what Xift asked before photos.
    // localModel: an Ollama model name, or null for Jev through OpenRouter.
    function buildRequest(post, image = null, localModel = null) {
        const questions = {};
        for (const [key, [instructions, yes, no]] of Object.entries(!image ? QUESTIONS : localModel ? LOCAL_PHOTO_QUESTIONS : PHOTO_QUESTIONS)) {
            questions[key] = { type: "noul", instructions, criteria: { true: yes, false: no } };
        }
        const state = { post: capPost(post) };
        if (localModel) return { model: localModel, state, questions, ...(image && { images: [image.slice(image.indexOf(",") + 1)] }) };
        if (image) state.post.images = [{ type: "image_url", image_url: { url: image } }];
        return { model: MODEL, provider: { data_collection: "deny" }, state, questions };
    }

    const isProb = (p) => typeof p === "number" && p >= 0 && p <= 1;

    function parseRetryAfter(value, now = Date.now()) {
        if (value == null || value === "") return null;
        if (/^\d+$/.test(value)) return Number(value) * 1000;
        const at = Date.parse(value);
        return Number.isNaN(at) ? null : Math.max(0, at - now);
    }

    // local: the answer came from Ollama, whose 403 refuses the add-on itself and whose errors are plain strings.
    function classify(status, body, retryAfter, local = false) {
        const fail = (kind) => ({ ok: false, kind, status, retryAfterMs: parseRetryAfter(retryAfter) });
        if (local && status === 403) return { ...fail("permanent"), message: 'Ollama refuses add-ons: start it with OLLAMA_ORIGINS="moz-extension://*"' };
        if (local && status === 404) return { ...fail("permanent"), message: String(body?.error ?? "").slice(0, 200) };
        // Such as a model too big for this computer's memory: retried, since freeing memory fixes it, with Ollama's reason.
        if (local && status >= 500) return { ...fail("temporary"), message: String(body?.error ?? "").slice(0, 200) };
        if (status === 200) {
            const answers = body && !body.error ? body.answers : undefined;
            const scores = {};
            for (const key of Object.keys(QUESTIONS)) {
                const answer = answers?.[key];
                if (answer?.type !== "noul" || !isProb(answer.noul)) return fail("temporary");
                scores[key] = answer.noul;
            }
            const cost = typeof body.usage?.cost === "number" ? body.usage.cost : null;
            return { ok: true, scores, cost, model: typeof body.model === "string" ? body.model : null };
        }
        // OpenRouter's in-flight budget clears by itself; any other 402 means the key's credit is spent.
        if (status === 402) return fail(JSON.stringify(body ?? "").includes("openrouter_in_flight_budget") ? "temporary" : "permanent");
        // About this post (its text, or a photo Jev refused): fail it alone, keeping Jev's reason for the log.
        const message = String(body?.error?.message ?? "").slice(0, 200);
        if (status === 400 || status === 403) return { ...fail("post"), message };
        if (status === 0 || status === 408 || status === 429 || status >= 500) return fail("temporary");
        return { ...fail("permanent"), message }; // 404 or 410: a retired model, say
    }

    const backoffMs = (attempt, retryAfterMs) => Math.min(MAX_BACKOFF_MS, Math.max(BACKOFF_MS[attempt] ?? BACKOFF_MS.at(-1), retryAfterMs ?? 0));

    globalThis.SiftJev = { ENDPOINT, MODEL, LOCAL_ENDPOINT, CAPS, QUESTIONS, PHOTO_QUESTIONS, LOCAL_PHOTO_QUESTIONS, readsImages, photoUrl, imageBox, capPost, buildRequest, classify, parseRetryAfter, backoffMs };
    if (typeof module !== "undefined") module.exports = globalThis.SiftJev;
})();
