// Xift background: holds the key, calls Jev through a small queue, reuses Jev's recent scores, counts what the calls
// cost, logs, learns from your clicks, and shows errors.
// Loaded after verdict.js, jev.js and db.js. Listeners are registered synchronously at load, so Firefox can
// wake this script for them after unloading it.
(() => {
    const { verdict, learnFrom, settingsFrom, cleanScores, wordCount, MIN_WORDS, cleanSeen, seenTrimDue, SCORES_MS, savedScores, addSpend, limitReached, monthAfter } =
        globalThis.SiftVerdict;
    const Jev = globalThis.SiftJev;
    const MAX_IN_FLIGHT = 8;
    const TIMEOUT_MS = 3000;
    // Ollama answers one call at a time and loads the model on its first call, so fewer calls wait longer.
    // ponytail: fixed figures, from 4B and 9B models on a 16 GB M4; tune if bigger models time out.
    const LOCAL_IN_FLIGHT = 2;
    const LOCAL_TIMEOUT_MS = 20_000;
    const PHOTO_COST_GUESS = 0.00008; // a call with a photo when OpenRouter reports no cost (text calls: COST_GUESS)
    const ATTEMPTS = 3; // the first try and two retries
    const SETTINGS = ["key", "dummy", "enabled", "collapseAds", "collapseLittleText", "thresholds", "provider", "localModel"];
    const LOG_MS = 90 * 24 * 60 * 60 * 1000; // judging entries are kept 90 days, so Export stays quick

    let stopped = null; // a permanent failure: no calls until the key changes
    let errorShown = true; // unknown after a restart, so the first success clears any old badge
    let active = 0;
    const waiting = [];
    let learning = Promise.resolve(); // learning steps run one at a time
    let saving = Promise.resolve(); // seen posts are written one at a time
    let spending = Promise.resolve(); // what the calls cost is added up one call at a time
    const calling = new Map(); // post ID → its Jev call under way
    let seenSaves = 0;
    const seenLimit = async () => settingsFrom(await browser.storage.local.get("seenLimit")).seenLimit;

    const fromX = (sender) => sender.id === browser.runtime.id && String(sender.tab?.url ?? "").startsWith("https://x.com/");
    const isPostId = (id) => /^\d{1,25}$/.test(String(id));
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // The dummy switch works only in a development install (web-ext run, about:debugging), never in a signed one.
    const devInstall = browser.management.getSelf().then((self) => self.installType === "development", () => false);

    // At most max calls at once; the rest wait here.
    async function withSlot(fn, max = MAX_IN_FLIGHT) {
        while (active >= max) await new Promise((resolve) => waiting.push(resolve));
        active++;
        try {
            return await fn();
        } finally {
            active--;
            waiting.shift()?.();
        }
    }

    // The timer starts here, when the request is sent, not when it was queued. local: Ollama, which needs no key.
    async function callJev(body, key, local) {
        const started = performance.now();
        const ms = () => Math.round(performance.now() - started);
        try {
            const res = await fetch(local ? Jev.LOCAL_ENDPOINT : Jev.ENDPOINT, {
                method: "POST",
                headers: local ? { "Content-Type": "application/json" } : { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(local ? LOCAL_TIMEOUT_MS : TIMEOUT_MS),
            });
            const json = await res.json().catch(() => null);
            return { status: res.status, body: json, retryAfter: res.headers.get("Retry-After"), ms: ms() };
        } catch {
            return { status: 0, body: null, retryAfter: null, ms: ms() }; // timeout or network error
        }
    }

    // priv: the post is from a private window, which records nothing.
    function log(entry, priv = false) {
        if (priv) return;
        SiftDB.add({ t: Date.now(), ...entry }).catch((err) => console.error("Xift log write failed", err));
    }

    // While a permanent stop holds, only another permanent failure replaces its error: calls already under way when it
    // happened mustn't bury it (the popup reads lastError).
    function showError(failure) {
        if (stopped && failure.kind !== "permanent") return;
        errorShown = true;
        browser.action.setBadgeText({ text: "!" });
        browser.action.setBadgeBackgroundColor({ color: "#d93025" });
        browser.storage.session.set({ lastError: { t: Date.now(), status: failure.status, kind: failure.kind, ...(failure.message && { message: failure.message }) } });
    }

    // The spending limit isn't an error: a grey badge, and nothing in lastError, so a real error stays readable.
    function showPaused() {
        errorShown = true;
        browser.action.setBadgeText({ text: "$" });
        browser.action.setBadgeBackgroundColor({ color: "#5f6368" });
    }

    // A new limit or a reset clears the "$" badge, never a real error's "!". errorShown stays, so the next success also
    // clears an error saved before the pause.
    async function clearPaused() {
        if ((await browser.action.getBadgeText({})) !== "$") return;
        browser.action.setBadgeText({ text: "" });
    }

    function clearError() {
        if (!errorShown || stopped) return;
        errorShown = false;
        browser.action.setBadgeText({ text: "" });
        browser.storage.session.remove("lastError");
    }

    // Adds a call's cost to today's, this month's and the running spending, read and written in turn so parallel calls
    // add up. Only the background writes spend: Reset writes spendReset, so a reset can't be lost under a call's write.
    function addCost(cost) {
        spending = spending
            .then(async () => {
                const { spend, spendReset } = await browser.storage.local.get(["spend", "spendReset"]);
                await browser.storage.local.set({ spend: addSpend(spend, cost, Date.now(), spendReset) });
            })
            .catch((err) => console.error("Xift spending update failed", err));
    }

    // When Xift may call Jev again, if the month's spending has reached your limit, else null: the 1st of next month,
    // unless a reset or a new limit ends the pause sooner (the pages then ask again). Waits for the costs already added,
    // so a call that just finished counts.
    async function pausedUntil() {
        await spending;
        const raw = await browser.storage.local.get(["spend", "spendReset", "dailyLimit"]);
        const now = Date.now();
        return limitReached(raw.spend, settingsFrom(raw).dailyLimit, now, raw.spendReset) ? monthAfter(now) : null;
    }

    // Dev-only: browser.storage.local.set({ dummy: true }) answers without Jev, for checking page behaviour for free.
    async function dummyJudge(id) {
        await sleep(300 + Math.random() * 2700);
        const p = Math.random() < 0.9 ? 0.95 : 0.05;
        return { id, scores: { bait: p, rage: 0, low: 0, promo: 0 } };
    }

    // When you saw this post, or null. A failed lookup counts as not seen, so judging never waits on the Seen list.
    async function seenWhen(id) {
        try {
            return (await SiftDB.getSeen(id))?.seenAt ?? null;
        } catch {
            return null;
        }
    }

    // Home asks to skip a post you've seen: the answer is just when you saw it, without Jev. Every other answer
    // carries that time too, when there is one, so a tab learns about posts you read before it judged them.
    // priv: from a private window, so nothing is logged or saved; the post still goes to Jev.
    async function judge(msg, priv) {
        const id = String(msg.id ?? "");
        if (!isPostId(id)) return { id, error: true };
        const seen = await seenWhen(id);
        if (seen !== null && msg.home === true) {
            log({ type: "skipped", id, reason: "seen" }, priv);
            return { id, seen };
        }
        // An author you always show: no call. The page asks only for Home's seen check, answered above.
        if (msg.trusted === true) return seen === null ? { id, trusted: true } : { id, trusted: true, seen };
        const res = await judgeAnew(msg, id, priv);
        return seen === null ? res : { ...res, seen };
    }

    async function judgeAnew(msg, id, priv) {
        const raw = await browser.storage.local.get(SETTINGS);
        if (raw.dummy && (await devInstall)) return dummyJudge(id);
        const byYou = (await SiftDB.getLabel(id).catch(() => undefined))?.wanted;
        if (byYou) return { id, byYou }; // your correction sticks, without calling Jev
        const entry = await SiftDB.getScores(id).catch(() => undefined);
        const saved = savedScores(entry, Date.now(), settingsFrom(raw).local);
        if (saved) {
            // With the verdict under today's thresholds, so the popup can count what was collapsed and why.
            const v = verdict({ scores: saved }, settingsFrom(raw));
            log({ type: "skipped", id, reason: "reused", verdict: v.collapsed ? "collapsed" : "open", label: v.label }, priv);
            return entry.photo ? { id, scores: saved, photo: true } : { id, scores: saved };
        }
        const post = Jev.capPost(msg.post);
        const { local } = settingsFrom(raw);
        const hasPhoto = Jev.photoUrl(msg.post?.photo);
        const photo = local && !Jev.readsImages(local) ? null : hasPhoto; // a local model that can't see it judges the text
        const enoughText = wordCount(`${post.text} ${post.quoted} ${post.alt}`) >= MIN_WORDS;
        // A post with a photo is judged however short its text; a short one the model can't see stays open, unjudged.
        // ponytail: it's asked about again after the page's cool-down, logged each time, like "photo unavailable".
        if (!photo && !enoughText && hasPhoto) {
            log({ type: "skipped", id, reason: "photo not read" }, priv);
            return { id, error: true };
        }
        if (!photo && !enoughText) return tooLittle(id, priv);
        if (!local && !raw.key) {
            showError({ status: "no key", kind: "permanent" });
            return { id, error: true };
        }
        // A post already being asked about (a second tab, or a reload while the first call waits) shares that call;
        // a private window's call records nothing, so it's shared only with private windows.
        const slot = priv ? `private ${id}` : id;
        let call = calling.get(slot);
        if (!call) {
            call = ask(id, post, photo, enoughText, raw, priv).finally(() => calling.delete(slot));
            calling.set(slot, call);
        }
        return call;
    }

    function tooLittle(id, priv) {
        log({ type: "skipped", id, reason: "too little text" }, priv);
        return { id, tooLittle: true };
    }

    // A photo for Jev: fetched from X's image server (it answers any origin, so no extra permission), fitted to Jev's
    // 280 to 1,568 px on white, and sent as a JPEG data URL; re-encoding drops the photo's metadata. null if anything fails.
    async function photoData(url) {
        try {
            const res = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (!res.ok) return null;
            const bitmap = await createImageBitmap(await res.blob());
            const box = Jev.imageBox(bitmap.width, bitmap.height);
            const canvas = new OffscreenCanvas(box.w, box.h);
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, box.w, box.h);
            ctx.drawImage(bitmap, box.x, box.y, box.dw, box.dh);
            bitmap.close();
            const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
            return await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
            });
        } catch {
            return null;
        }
    }

    // photo: X's URL for the post's first photo, or null. The photo is fetched only now, when Jev will be asked, and in
    // a slot like the calls, so a fast scroll can't start dozens at once. Without it, the text rules apply.
    // Local calls cost nothing, so the spending limit never pauses them.
    async function ask(id, post, photo, enoughText, raw, priv) {
        if (stopped) return { id, error: true };
        const { local } = settingsFrom(raw);
        const slots = local ? LOCAL_IN_FLIGHT : MAX_IN_FLIGHT;
        let image = null;
        if (photo) {
            const until = local ? null : await pausedUntil(); // no photo fetched for a call the spending limit would stop
            if (until !== null) {
                showPaused();
                return { id, paused: until };
            }
            image = await withSlot(() => photoData(photo), slots);
            if (!image) {
                // Most likely X's server or the network for a moment: a short post is asked about again after the page's
                // cool-down, and a text-only answer isn't saved, so the next visit tries the photo again.
                log({ type: "skipped", id, reason: "photo unavailable" }, priv);
                if (!enoughText) return { id, error: true };
            }
        }
        if (!image && !enoughText) return tooLittle(id, priv);
        const save = !priv && (!photo || Boolean(image)); // a refused photo counts as tried, see below
        let body = Jev.buildRequest(post, image, local);
        for (let attempt = 0; ; attempt++) {
            // The stop is checked and set inside the slot, before it frees, so nothing queued behind a
            // permanent failure goes out. The spending limit is checked there too, just before each call and retry, and a
            // call's cost is added before its slot frees, so the next call's check counts it.
            const outcome = await withSlot(async () => {
                if (stopped) return null;
                const until = local ? null : await pausedUntil();
                if (until !== null) return { until };
                const res = await callJev(body, raw.key, local);
                let result = Jev.classify(res.status, res.body, res.retryAfter, Boolean(local));
                // With a photo, any other 4xx is about this request (413, 415, 422…), not the key: fall back to the text.
                // Ollama's 403 and 404 are about Ollama itself.
                if (image && !local && result.kind === "permanent" && res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 402) result = { ...result, kind: "post" };
                if (result.kind === "permanent") stopped = result;
                if (result.ok && !local) addCost(Number.isFinite(result.cost) ? result.cost : image ? PHOTO_COST_GUESS : null);
                return { res, result };
            }, slots);
            if (!outcome) return { id, error: true };
            if (outcome.until) {
                showPaused();
                return { id, paused: outcome.until };
            }
            const { res, result } = outcome;
            if (result.ok) {
                const settings = settingsFrom(raw);
                const v = verdict({ scores: result.scores }, settings);
                log({ type: "judged", id, scores: result.scores, verdict: v.collapsed ? "collapsed" : "open", label: v.label, thresholds: settings.thresholds, ms: res.ms, cost: result.cost, model: result.model, photo: Boolean(image) }, priv);
                if (save) SiftDB.putScores(id, result.scores, Date.now(), Boolean(image), local).catch((err) => console.error("Xift scores write failed", err));
                // This call may be the one that reached the limit: then the badge says so, not just "no error".
                if (!local && (await pausedUntil()) !== null) showPaused();
                else clearError();
                return image ? { id, scores: result.scores, photo: true } : { id, scores: result.scores };
            }
            // Jev refused the post with its photo (too thin a photo, say): judge the text alone, with fresh retries.
            if (image && result.kind === "post") {
                log({ type: "skipped", id, reason: "photo refused", status: result.status, message: result.message }, priv);
                image = null;
                if (!enoughText) return tooLittle(id, priv);
                body = Jev.buildRequest(post, null, local);
                attempt = -1;
                continue;
            }
            if (result.kind !== "temporary" || attempt === ATTEMPTS - 1) {
                log({ type: "failed", id, status: result.status, kind: result.kind }, priv);
                showError(result);
                return { id, error: true };
            }
            await sleep(Jev.backoffMs(attempt, result.retryAfterMs));
        }
    }

    function onLabel(msg) {
        const id = String(msg.id);
        log({ type: "label", id, wanted: msg.wanted, was: String(msg.was ?? "").slice(0, 20) });
        const scores = cleanScores(msg.scores); // null for ads, short posts and earlier corrections
        // The label is read and written inside the queue too, so a quick hide then keep finds the hide's steps.
        learning = learning
            .then(async () => {
                const before = await SiftDB.getLabel(id).catch(() => undefined);
                const { thresholds } = settingsFrom(await browser.storage.local.get("thresholds"));
                const step = learnFrom(thresholds, before, scores, msg.wanted);
                await SiftDB.setLabel(id, msg.wanted, step.steps);
                if (step.changes.length === 0) return;
                await browser.storage.local.set({ thresholds: step.thresholds });
                step.changes.forEach((change) => log({ type: "learn", ...change, cause: step.cause, id }));
            })
            .catch((err) => console.error("Xift label or learning failed", err));
    }

    // A post you've seen, from an X tab outside private windows: checked field by field, timed here, and saved. The
    // first save after the background wakes, then every 100th, also trims the list to your limit, in the same
    // transaction (see seenTrimDue). A full disk trims and drops this one.
    function onSeen(msg, sender) {
        if (sender.tab?.incognito) return;
        const record = cleanSeen(msg.record, Date.now());
        if (!record) return console.warn("Xift: a seen post without a valid ID or handle was dropped");
        saving = saving
            .then(async () => {
                const limit = await seenLimit();
                try {
                    await SiftDB.putSeen(record, seenTrimDue(++seenSaves) ? limit : null);
                } catch (err) {
                    if (err?.name !== "QuotaExceededError") throw err;
                    await SiftDB.trimSeen(limit);
                }
            })
            .catch((err) => console.error("Xift seen write failed", err));
    }

    browser.runtime.onMessage.addListener((msg, sender) => {
        if (!fromX(sender)) return undefined;
        const priv = sender.tab?.incognito === true; // a private window: judged, but nothing is recorded or learnt
        if (msg?.type === "judge") return judge(msg, priv);
        if (msg?.type === "skip" && msg.reason === "inherited" && isPostId(msg.id)) log({ type: "skipped", id: String(msg.id), reason: "inherited" }, priv);
        if (msg?.type === "label" && isPostId(msg.id) && (msg.wanted === "show" || msg.wanted === "hide") && !priv) onLabel(msg);
        if (msg?.type === "seen") onSeen(msg, sender);
        return undefined;
    });

    // Re-entering the key, even the same one, clears a permanent stop, as do picking a model and the popup's Retry. A new
    // limit or a reset clears the pause's "$"; the next call shows it again if the limit is still reached.
    browser.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && ["key", "provider", "localModel", "retryAt"].some((k) => k in changes)) stopped = null;
        if (area === "local" && ("dailyLimit" in changes || "spendReset" in changes)) clearPaused();
        if (area === "local" && "seenLimit" in changes) {
            saving = saving.then(async () => SiftDB.trimSeen(await seenLimit())).catch((err) => console.error("Xift seen trim failed", err));
        }
    });

    // Saved scores are dropped after 7 days, and on every update: a new version may ask Jev different questions.
    browser.runtime.onInstalled.addListener(({ reason }) => {
        if (reason === "update") SiftDB.clearScores().catch((err) => console.error("Xift scores clear failed", err));
    });
    SiftDB.trimScores(Date.now() - SCORES_MS).catch((err) => console.error("Xift scores trim failed", err));
    SiftDB.trimLog(Date.now() - LOG_MS).catch((err) => console.error("Xift log trim failed", err));
})();
