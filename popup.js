// Xift popup: the on/off switch, a status line with its fix, three tiles (focus mode, replies, the Seen list), and four
// tabs: Today, Sensitivity, Always show and Settings. Explanations live in hover tips (data-tip): they show after a
// short rest on an element, or at once when it gets keyboard focus.
(() => {
    const { QUALITIES, DEFAULT_THRESHOLDS, defaultThresholds, switchModel, settingsFrom, spentNow, runningTotal, limitReached, money, handleKey } = SiftVerdict;
    const { REASONS, today, statusOf, keyOk, reportDetails } = SiftPopup;
    const $ = (id) => document.getElementById(id);
    const local = browser.storage.local;
    const X_ORIGINS = { origins: ["https://x.com/*"] };
    const REPO = "https://github.com/asaidaoui-netria/xift"; // where Report and Suggest open GitHub's issue forms
    const KEYS = ["enabled", "collapseAds", "collapseLittleText", "judgeReplies", "focus", "focusWidth", "focusText", "thresholds", "key", "seenLimit", "dailyLimit", "spend", "spendReset", "trusted", "provider", "localModel"];
    const REASON_UI = {
        low: { name: "Low substance", icon: "r-low", tip: "Filler, vague hype, empty one-liners" },
        bait: { name: "Bait", icon: "r-bait", tip: "Engagement bait: fishing for likes, replies or follows" },
        little: { name: "Too short", icon: "r-little", tip: "Under 5 words and no photo: collapsed without asking Jev" },
        rage: { name: "Rage", icon: "r-rage", tip: "Rage bait: written to provoke anger" },
        promo: { name: "Promo", icon: "r-promo", tip: "Self-promotion: selling, sign-ups, giveaways" },
        you: { name: "By you", icon: "r-you", tip: "Posts you hid with ⊘ or h" },
    };
    const QUALITY_UI = {
        bait: { name: "Bait", icon: "r-bait", hint: "Engagement bait: fishing for likes, replies or follows" },
        rage: { name: "Rage", icon: "r-rage", hint: "Rage bait: written to provoke anger" },
        low: { name: "Low substance", icon: "r-low", hint: "Filler, vague hype, empty one-liners" },
        promo: { name: "Promo", icon: "r-promo", hint: "Self-promotion: selling, sign-ups, giveaways" },
    };
    let thresholds = { ...DEFAULT_THRESHOLDS };
    let settings = settingsFrom({});
    let shownStatus = { kind: "ok" }; // the status line's state, for Report

    const logLearn = (key, from, to, cause) => SiftDB.add({ t: Date.now(), type: "learn", key, from, to, cause });
    // DOM building: an element with properties (dataset and style too) and children, and an icon from the sprite.
    function el(tag, props = {}, ...kids) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
            if (k === "dataset") Object.assign(node.dataset, v);
            else if (k === "style") node.style.cssText = v;
            else if (k in node) node[k] = v;
            else node.setAttribute(k, v);
        }
        node.append(...kids);
        return node;
    }
    function icon(id, cls = "", style = "") {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("aria-hidden", "true");
        if (cls) svg.setAttribute("class", cls);
        if (style) svg.setAttribute("style", style);
        const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
        use.setAttribute("href", `#${id}`);
        svg.append(use);
        return svg;
    }
    const midnight = () => new Date().setHours(0, 0, 0, 0);
    const dateOf = (t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(new Date(t).getFullYear() !== new Date().getFullYear() && { year: "numeric" }) });
    const compact = (n) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`);

    // ---------- Tabs ----------
    function showTab(name) {
        for (const tab of document.querySelectorAll('[role="tab"]')) {
            const on = tab.id === `tab-${name}`;
            tab.setAttribute("aria-selected", String(on));
            $(tab.getAttribute("aria-controls")).hidden = !on;
        }
    }
    for (const tab of document.querySelectorAll('[role="tab"]')) tab.addEventListener("click", () => showTab(tab.id.slice(4)));

    // ---------- Status line ----------
    const STATUS = {
        ok: ["i-ok", "", "Sifting", () => "Judging posts on Home, search, lists and post pages"],
        off: ["i-off", "off", "Off", () => "X shows as it is"],
        access: ["i-stop", "bad", "No access to x.com", () => "Firefox needs your permission for Xift to work on x.com"],
        nokey: ["i-stop", "bad", "", () => "Use a dedicated OpenRouter key with a small credit limit"],
        credit: ["i-stop", "bad", "Out of credit", () => "OpenRouter has no credit left. Top up, then enter the key again."],
        badkey: ["i-stop", "bad", "Key refused", () => "OpenRouter didn't accept the key. Enter it again."],
        stopped: ["i-stop", "bad", "Stopped", (s) => `OpenRouter answered ${s.status}${why(s)}. If entering the key again doesn't help, Xift may need an update.`],
        paused: ["i-pause", "warn", "Limit reached", (s) => `About ${money(s.total)} spent since ${dateOf(s.since)}, of your ${money(settings.dailyLimit ?? 0)} monthly limit. Posts not judged yet show unfiltered until the 1st, or until you reset the spending or raise the limit.`],
        trouble: ["i-pause", "warn", "Trouble reaching Jev", (s) => `Last error: ${s.status}. Xift retries on its own.`],
        refused: ["i-pause", "warn", "Jev refused a post", (s) => `OpenRouter answered ${s.status}${why(s)}. Refused posts show unfiltered. If every post is refused, Xift may need an update.`],
    };
    // With Ollama judging: no key, no spending, and its own fixes.
    const LOCAL_STATUS = {
        stopped: ["i-stop", "bad", "Stopped", (s) => `Ollama answered ${s.status}${why(s)}. Fix that, then press Retry.`],
        trouble: ["i-pause", "warn", "Trouble reaching Ollama", (s) => (s.message ? `Ollama answered ${s.status}${why(s)}. Xift retries on its own.` : `Last error: ${s.status}. Check that Ollama is running. Xift retries on its own.`)],
        refused: ["i-pause", "warn", "Ollama refused a post", (s) => `Ollama answered ${s.status}${why(s)}. Refused posts show unfiltered.`],
    };
    const why = (s) => (s.message ? `: “${s.message}”` : "");
    async function showStatus() {
        const raw = await local.get(["enabled", "key", "spend", "spendReset", "dailyLimit", "provider", "localModel"]);
        const { local: model } = settingsFrom(raw);
        const { lastError } = await browser.storage.session.get("lastError");
        const now = Date.now();
        const s = statusOf({
            enabled: raw.enabled !== false,
            access: await browser.permissions.contains(X_ORIGINS),
            key: Boolean(raw.key),
            lastError: lastError ?? null,
            paused: limitReached(raw.spend, settingsFrom(raw).dailyLimit, now, raw.spendReset),
            local: model,
        });
        Object.assign(s, runningTotal(raw.spend, now, raw.spendReset));
        shownStatus = s;
        const [ico, cls, title, tip] = (model && LOCAL_STATUS[s.kind]) || STATUS[s.kind];
        const box = $("status");
        box.dataset.tip = tip(s);
        // Redrawn only when the status changes: the background rewrites its error for every post it can't judge, and a
        // redraw would wipe a key you're pasting (and repeat the line to a screen reader).
        const sig = `${s.kind}|${s.status ?? ""}|${model ?? ""}`;
        if (box.dataset.sig === sig) return;
        box.dataset.sig = sig;
        box.className = `status ${cls}`;
        box.replaceChildren(icon(ico, "ico"));
        if (s.kind === "nokey") {
            const field = Object.assign(document.createElement("input"), { type: "password", placeholder: "Paste your OpenRouter key", autocomplete: "off", spellcheck: false });
            field.setAttribute("aria-label", "OpenRouter key");
            field.addEventListener("change", () => saveKey(field));
            box.append(field);
            return;
        }
        box.append(el("b", { textContent: title }));
        // [text, tip, act, ask]: with ask, the button asks for a second click first.
        const enterKey = ["Enter key", "Paste your OpenRouter key", () => goTo("changeKey")];
        const reportIt = ["Report", "Copies Xift's details and opens GitHub's issue form, for you to paste them in", report];
        const retry = ["Retry", "Asks Ollama again", () => local.set({ retryAt: Date.now() }).then(() => browser.storage.session.remove("lastError"))];
        const actions = {
            access: [["Allow", "Asks Firefox for access to x.com", grant]],
            credit: [enterKey],
            badkey: [enterKey],
            stopped: [enterKey, reportIt],
            refused: [reportIt],
            paused: [
                ["Reset", "Counts this month's spending again from $0", resetSpend, "Again"],
                ["Raise limit", "Opens Settings at the limit", () => goTo("dailyLimit")],
            ],
        }[s.kind] ?? [];
        if (model && s.kind === "stopped") actions.splice(0, actions.length, retry, reportIt);
        for (const [text, tip, act, ask] of actions) {
            const button = el("button", { className: "btn", textContent: text, dataset: { tip } });
            if (ask) twoClick(button, ask, act);
            else button.addEventListener("click", act);
            box.append(button);
        }
    }

    // Report copies Xift's details for you to paste into GitHub's issue form, then opens it. Xift sends nothing itself:
    // Mozilla counts versions and settings as technical data, which would need its own permission.
    async function report() {
        const text = reportDetails({ version: browser.runtime.getManifest().version, browser: await browser.runtime.getBrowserInfo(), os: (await browser.runtime.getPlatformInfo()).os, status: shownStatus, settings });
        await navigator.clipboard.writeText(text).catch(() => {}); // the form says to check what you paste
        browser.tabs.create({ url: `${REPO}/issues/new?template=bug.yml` });
    }
    $("report").addEventListener("click", report);
    $("suggest").addEventListener("click", () => browser.tabs.create({ url: `${REPO}/issues/new?template=feature.yml` }));

    // Reset writes only when it happened: the background, the only writer of spend, counts from then (see runningTotal).
    function resetSpend() {
        return local.set({ spendReset: Date.now() });
    }

    // Opens Settings at a control: the limit field, or the key field.
    function goTo(id) {
        showTab("settings");
        if (id === "changeKey") openKeyField();
        else $(id).focus();
        $(id === "changeKey" ? "key" : id).scrollIntoView({ block: "center" });
    }

    // permissions.request must run straight from the click.
    function grant() {
        browser.permissions.request(X_ORIGINS).then(() => Promise.all([showStatus(), showAccess()]));
    }

    // ---------- Tiles ----------
    function showTiles() {
        $("enabled").checked = settings.enabled;
        $("focus").setAttribute("aria-pressed", String(settings.focus));
        $("judgeReplies").setAttribute("aria-pressed", String(settings.judgeReplies));
    }
    $("enabled").addEventListener("change", () => local.set({ enabled: $("enabled").checked }));
    for (const id of ["focus", "judgeReplies"]) {
        $(id).addEventListener("click", () => {
            const on = $(id).getAttribute("aria-pressed") !== "true";
            $(id).setAttribute("aria-pressed", String(on)); // at once, so a quick second click toggles back
            local.set({ [id]: on });
        });
    }
    $("openSeen").addEventListener("click", () => browser.tabs.create({ url: browser.runtime.getURL("seen.html") }));
    async function showSeenCount() {
        const n = await SiftDB.countSeen().catch(() => 0);
        $("seenCount").textContent = compact(n);
        $("openSeen").dataset.tip = `Your reading history: ${n.toLocaleString("en-US")} posts. Opens in a tab.`;
    }

    // ---------- Today ----------
    async function showToday() {
        const t = today(await SiftDB.since(midnight()).catch(() => []), settings);
        $("panel-today").classList.remove("dimmed");
        $("collapsed").textContent = t.collapsed;
        $("collapsed").dataset.tip = [
            `${t.collapsed} sifted out today. Jev judged ${t.judged} ${t.judged === 1 ? "post" : "posts"}.`,
            t.reused ? `${t.reused} answers came from saved scores, at no cost.` : "",
            t.corrections ? `${t.corrections} corrections taught ${t.steps} ${t.steps === 1 ? "step" : "steps"}.` : "",
        ].filter(Boolean).join(" ");
        $("stack").replaceChildren(
            ...REASONS.filter((r) => t.by[r.key]).map((r) => el("i", { style: `flex: ${t.by[r.key]}; background: var(--c-${r.key})`, dataset: { k: r.key, tip: `${REASON_UI[r.key].name} · ${t.by[r.key]}` } })),
        );
        $("legend").replaceChildren(
            ...REASONS.map((r) => {
                const ui = REASON_UI[r.key];
                return el("div", { dataset: { k: r.key, tip: ui.tip } }, icon(ui.icon, "", `color: var(--c-${r.key})`), ui.name, el("b", { textContent: t.by[r.key] }));
            }),
        );
        const raw = await local.get(["spend", "spendReset", "dailyLimit"]);
        const now = Date.now();
        const spent = spentNow(raw.spend, now);
        const { total, since } = runningTotal(raw.spend, now, raw.spendReset);
        const limit = settingsFrom(raw).dailyLimit;
        const about = (x) => (x < 0.001 ? money(x) : `~${money(x)}`);
        $("spent").textContent = about(total);
        $("spentBar").style.width = limit ? `${Math.min(100, (total / limit) * 100)}%` : "0";
        $("limitNote").textContent = limit ? money(limit) : "no limit";
        $("spentSince").textContent = `since ${dateOf(since)}`;
        $("money").classList.toggle("warn", limitReached(raw.spend, limit, now, raw.spendReset));
        $("money").dataset.tip = `About ${money(total)} spent since ${dateOf(since)}${limit ? `, of your ${money(limit)} monthly limit` : ""} · ${money(spent.today)} today · ${money(spent.month)} this month. Counted from the cost OpenRouter reports for each call.`;
    }
    // A bar segment and its legend row light up together.
    $("panel-today").addEventListener("mouseover", (e) => {
        const k = e.target.closest?.("[data-k]")?.dataset.k;
        $("panel-today").classList.toggle("dimmed", Boolean(k));
        for (const el of $("panel-today").querySelectorAll("[data-k]")) el.classList.toggle("lit", el.dataset.k === k);
    });
    $("panel-today").addEventListener("mouseleave", () => $("panel-today").classList.remove("dimmed"));

    // ---------- Sensitivity ----------
    function buildSliders() {
        $("sliders").replaceChildren(
            ...QUALITIES.map(({ key, name }) => {
                const ui = QUALITY_UI[key];
                const d = DEFAULT_THRESHOLDS[key];
                return el("div", { className: "q" },
                    icon(ui.icon, "", `color: var(--c-${key})`),
                    el("span", {}, el("b", { textContent: ui.name, dataset: { tip: ui.hint } }), el("span", { className: "moved", id: `m-${key}` })),
                    el("output", { id: `v-${key}`, dataset: { tip: "Collapse when the model is at least this sure" } }),
                    el("div", { className: "rng" },
                        el("input", { type: "range", min: "0.05", max: "0.99", step: "0.01", id: `t-${key}`, "aria-label": name }),
                        el("span", { className: "tick", id: `k-${key}`, style: `left: calc(8px + (100% - 16px) * ${((d - 0.05) / 0.94).toFixed(4)})`, dataset: { tip: `Default ${d.toFixed(2)}` } })));
            }),
        );
        for (const { key } of QUALITIES) {
            const input = $(`t-${key}`);
            input.addEventListener("input", () => showSlider(key, Number(input.value)));
            input.addEventListener("change", async () => {
                const to = Number(input.value);
                const from = thresholds[key];
                if (to === from) return;
                thresholds = { ...thresholds, [key]: to };
                await local.set({ thresholds });
                await logLearn(key, from, to, "slider");
            });
        }
    }
    function showSlider(key, v) {
        $(`v-${key}`).textContent = v.toFixed(2);
        const d = defaultThresholds(settings.local)[key]; // each model has its own defaults
        const diff = Math.round((v - d) * 100) / 100;
        const m = $(`m-${key}`);
        m.textContent = diff ? `${diff < 0 ? "▼" : "▲"}${Math.abs(diff).toFixed(2)}` : "";
        m.dataset.tip = diff ? `${diff < 0 ? "Stricter" : "Looser"} than the default ${d.toFixed(2)}, from your Keeps, Hides or this slider` : "";
    }
    function showSliders() {
        const defaults = defaultThresholds(settings.local);
        for (const { key } of QUALITIES) {
            const tick = $(`k-${key}`);
            tick.style.left = `calc(8px + (100% - 16px) * ${((defaults[key] - 0.05) / 0.94).toFixed(4)})`;
            tick.dataset.tip = `Default ${defaults[key].toFixed(2)}`;
            $(`t-${key}`).value = String(thresholds[key]);
            showSlider(key, thresholds[key]);
        }
    }

    // The first click asks; a second click within 3 s acts.
    function twoClick(button, ask, act) {
        const text = button.textContent;
        let armed = null;
        button.addEventListener("click", async () => {
            if (!armed) {
                button.textContent = ask;
                armed = setTimeout(() => {
                    armed = null;
                    button.textContent = text;
                }, 3000);
                return;
            }
            clearTimeout(armed);
            armed = null;
            button.textContent = text;
            await act();
        });
    }
    twoClick($("reset"), "Again to reset", async () => {
        const from = thresholds;
        thresholds = defaultThresholds(settings.local);
        await local.set({ thresholds });
        for (const { key } of QUALITIES) if (from[key] !== thresholds[key]) await logLearn(key, from[key], thresholds[key], "reset");
        showSliders();
    });

    // ---------- Always show ----------
    async function showTrusted() {
        const { trusted } = settingsFrom(await local.get("trusted"));
        $("trustedList").replaceChildren(
            ...trusted.map((key) => {
                const item = document.createElement("li");
                item.dataset.tip = "Their posts always show and never cost a call";
                const av = Object.assign(document.createElement("span"), { className: "av", textContent: key[0].toUpperCase() });
                const name = Object.assign(document.createElement("span"), { className: "h", textContent: `@${key}` });
                const remove = Object.assign(document.createElement("button"), { className: "x", type: "button", textContent: "×" });
                remove.dataset.tip = `Stop always showing @${key}`;
                remove.setAttribute("aria-label", remove.dataset.tip);
                remove.addEventListener("click", async () => {
                    await local.set({ trusted: settingsFrom(await local.get("trusted")).trusted.filter((k) => k !== key) });
                    await showTrusted();
                });
                item.append(av, name, remove);
                return item;
            }),
        );
        $("trustedNone").hidden = trusted.length > 0;
    }
    // Adds an author by handle, when you leave the field, press Enter or click Add. Anything that isn't a handle stays.
    async function addTrusted() {
        const field = $("trustedAdd");
        if (!field.value.trim()) return;
        const key = handleKey(field.value.trim());
        if (!key) {
            field.setCustomValidity("Type a handle, such as @jack");
            field.reportValidity();
            return;
        }
        const now = settingsFrom(await local.get("trusted")).trusted;
        if (!now.includes(key)) await local.set({ trusted: [...now, key] });
        field.value = "";
        await showTrusted();
    }
    $("trustedAdd").addEventListener("input", () => $("trustedAdd").setCustomValidity(""));
    $("trustedAdd").addEventListener("change", addTrusted);
    $("trustedAddBtn").addEventListener("click", addTrusted);

    // ---------- Settings ----------
    for (const id of ["collapseAds", "collapseLittleText"]) $(id).addEventListener("change", () => local.set({ [id]: $(id).checked }));
    for (const seg of document.querySelectorAll("[data-choice]")) {
        seg.addEventListener("click", (e) => {
            const button = e.target.closest("button");
            if (button) local.set({ [seg.dataset.choice]: button.value });
        });
    }
    // Who judges: Jev through OpenRouter, or a decision model in Ollama on this computer. Each model gets back the
    // thresholds it learnt (switchModel). Ollama needs no host permission: Firefox sends the add-on's origin either way,
    // so OLLAMA_ORIGINS is what lets Xift in (checked 2026-10-19).
    $("provider").addEventListener("click", (e) => {
        const provider = e.target.closest("button")?.value;
        if (provider && provider !== (settings.local ? "local" : "openrouter")) pickModel({ provider, localModel: settings.localModel });
    });
    $("localModel").addEventListener("change", () => {
        const field = $("localModel");
        const model = field.value.trim();
        if (!field.checkValidity() || !model || model === settings.local) return;
        pickModel({ provider: "local", localModel: model });
    });
    async function pickModel(next) {
        await local.set(switchModel(await local.get(["provider", "localModel", "thresholds", "savedThresholds"]), next));
        await browser.storage.session.remove("lastError");
    }

    function showSettings() {
        for (const button of $("provider").querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.value === (settings.local ? "local" : "openrouter")));
        $("localRow").hidden = !settings.local;
        if (document.activeElement !== $("localModel")) $("localModel").value = settings.localModel;
        $("collapseAds").checked = settings.collapseAds;
        $("collapseLittleText").checked = settings.collapseLittleText;
        for (const seg of document.querySelectorAll("[data-choice]")) {
            for (const button of seg.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.value === settings[seg.dataset.choice]));
        }
    }

    // The key: shown as set or not, never as text. Change opens a password field; saving it clears the last error, so
    // the status line shows Xift going again (the background clears its badge on the next success).
    function openKeyField() {
        $("key").hidden = false;
        $("changeKey").hidden = true;
        $("key").focus();
    }
    $("changeKey").addEventListener("click", openKeyField);
    $("key").addEventListener("change", () => saveKey($("key")));
    async function saveKey(field) {
        const key = field.value.trim();
        if (!key) return;
        if (!keyOk(key)) {
            field.setCustomValidity("This has a character no key has, such as … or a space. Copy the key again.");
            field.reportValidity();
            field.addEventListener("input", () => field.setCustomValidity(""), { once: true });
            return;
        }
        await local.set({ key });
        await browser.storage.session.remove("lastError");
        $("key").value = "";
        $("key").hidden = true;
        $("changeKey").hidden = false;
        await Promise.all([showKey(), showStatus()]);
    }
    async function showKey() {
        const { key } = await local.get("key");
        $("keyState").textContent = key ? "set" : "not set";
        $("changeKey").textContent = key ? "Change" : "Add";
    }
    async function showAccess() {
        const ok = await browser.permissions.contains(X_ORIGINS);
        $("accessState").textContent = ok ? "allowed" : "not allowed";
        $("grant").hidden = ok;
    }
    $("grant").addEventListener("click", grant);
    $("export").addEventListener("click", () => browser.tabs.create({ url: browser.runtime.getURL("export.html") }));
    twoClick($("resetSpend"), "Again to reset", resetSpend);
    twoClick($("clear"), "Again to clear", async () => {
        await SiftDB.clear();
        await showToday();
    });

    // The spending limit, saved when you leave the field or press Enter. Empty means none, saved as 0 (no value at all
    // is the $1 default); junk goes back to the saved value.
    // A number field reads "" for text that isn't a number, so badInput tells junk from an emptied field.
    $("dailyLimit").addEventListener("change", async () => {
        const field = $("dailyLimit");
        if (field.value.trim() === "" && !field.validity.badInput) {
            await local.set({ dailyLimit: 0 });
        } else {
            const limit = settingsFrom({ dailyLimit: Number(field.value) }).dailyLimit;
            if (limit === null) {
                const saved = settingsFrom(await local.get("dailyLimit")).dailyLimit;
                field.value = saved === null ? "" : String(saved);
                return;
            }
            await local.set({ dailyLimit: limit });
        }
    });

    // The Seen list's limit, saved when you leave the field or press Enter, never while you type (typing 10000 passes
    // through 1, 10 and 100). Junk goes back to the saved value. Lowering it below what's stored asks first.
    $("seenLimit").addEventListener("input", () => ($("confirmLimit").hidden = true));
    $("seenLimit").addEventListener("change", async () => {
        const field = $("seenLimit");
        const confirm = $("confirmLimit");
        confirm.hidden = true;
        const saved = settingsFrom(await local.get("seenLimit")).seenLimit;
        const typed = field.value.trim() === "" ? NaN : Number(field.value);
        if (!Number.isFinite(typed)) {
            field.value = String(saved);
            return;
        }
        const limit = settingsFrom({ seenLimit: typed }).seenLimit;
        field.value = String(limit);
        if (limit === saved) return;
        const stored = await SiftDB.countSeen();
        if (limit < saved && stored > limit) {
            confirm.textContent = `Delete the ${(stored - limit).toLocaleString("en-US")} oldest posts`;
            confirm.hidden = false;
            confirm.onclick = async () => {
                confirm.hidden = true;
                await local.set({ seenLimit: limit });
            };
            return;
        }
        await local.set({ seenLimit: limit });
    });
    // Firefox fires no change for text that isn't a number: leaving such a field puts the saved value back.
    for (const id of ["seenLimit", "dailyLimit"]) {
        $(id).addEventListener("blur", async () => {
            if (!$(id).validity.badInput) return;
            const saved = settingsFrom(await local.get(id))[id];
            $(id).value = saved === null ? "" : String(saved);
        });
    }

    // ---------- Hover tips ----------
    let timer = 0;
    let shown = null;
    let tipEl = null;
    function showTip(target) {
        const text = target.dataset.tip;
        if (!text || !target.isConnected) return;
        hideTip(true);
        tipEl = Object.assign(document.createElement("div"), { className: "tip", textContent: text, id: "tip" });
        tipEl.setAttribute("role", "tooltip");
        target.setAttribute("aria-describedby", "tip");
        document.body.append(tipEl);
        const r = target.getBoundingClientRect();
        const t = tipEl.getBoundingClientRect();
        const left = Math.max(6, Math.min(r.left + r.width / 2 - t.width / 2, innerWidth - t.width - 6));
        let top = r.top - t.height - 8;
        const below = top < 4;
        if (below) top = r.bottom + 8;
        Object.assign(tipEl.style, { left: `${left}px`, top: `${Math.min(top, innerHeight - t.height - 4)}px` });
        tipEl.style.setProperty("--arrow", `${Math.max(10, Math.min(t.width - 10, r.left + r.width / 2 - left))}px`);
        tipEl.classList.toggle("below", below);
        const el = tipEl;
        requestAnimationFrame(() => el.classList.add("show"));
        shown = target;
    }
    function hideTip(now = false) {
        clearTimeout(timer);
        if (!tipEl) return;
        const el = tipEl;
        shown?.removeAttribute("aria-describedby");
        tipEl = null;
        shown = null;
        if (now) return el.remove();
        el.classList.add("leaving");
        el.classList.remove("show");
        setTimeout(() => el.remove(), 90);
    }
    document.addEventListener("mouseover", (e) => {
        const target = e.target.closest?.("[data-tip]");
        if (target === shown) return;
        if (!target?.dataset.tip) return hideTip();
        clearTimeout(timer);
        // Already showing one: move straight to the next, so reading along a row stays quick.
        if (tipEl) showTip(target);
        else timer = setTimeout(() => showTip(target), 350);
    });
    document.addEventListener("mouseleave", () => hideTip());
    document.addEventListener("focusin", (e) => {
        const target = e.target.closest?.("[data-tip]");
        if (target && e.target.matches(":focus-visible")) showTip(target);
    });
    document.addEventListener("focusout", () => hideTip());
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && tipEl) {
            e.preventDefault(); // closes the tip, not the popup
            hideTip(true);
        }
    });
    document.addEventListener("scroll", () => hideTip(true), true);
    document.addEventListener("click", () => hideTip(true));

    // ---------- Start, and follow changes ----------
    async function load() {
        settings = settingsFrom(await local.get(KEYS));
        thresholds = settings.thresholds;
    }
    async function init() {
        buildSliders();
        await load();
        showTiles();
        showSliders();
        showSettings();
        $("seenLimit").value = String(settings.seenLimit);
        $("dailyLimit").value = settings.dailyLimit === null ? "" : String(settings.dailyLimit);
        await Promise.all([showStatus(), showToday(), showSeenCount(), showTrusted(), showKey(), showAccess()]);
    }
    // Other parts of Xift change these while the popup is open: spending, the switches (f on X), learning, the list.
    browser.storage.onChanged.addListener(async (changes, area) => {
        if (area === "session" && "lastError" in changes) return showStatus();
        if (area !== "local") return;
        await load();
        showTiles();
        showSettings();
        if ("thresholds" in changes) showSliders();
        if ("trusted" in changes) showTrusted();
        if (["enabled", "key", "spend", "spendReset", "dailyLimit", "provider", "localModel"].some((k) => k in changes)) showStatus();
        if (["spend", "spendReset", "dailyLimit", "collapseLittleText"].some((k) => k in changes)) showToday();
        if ("seenLimit" in changes) setTimeout(showSeenCount, 1500); // the background trims after the change
    });
    init();
})();
