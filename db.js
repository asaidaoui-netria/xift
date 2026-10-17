// Xift's log, your corrections, the posts you've seen and Jev's saved scores, in IndexedDB. Shared by the background (writes), the popup,
// export.html and seen.html.
(() => {
    let opening;

    // Version 2 adds the seen store, version 3 the scores store. A page holding the database closes it when another page upgrades it, and opens it
    // again on its next call, so an open Xift tab never holds an upgrade up. A failed open is forgotten, not kept.
    function open() {
        opening ??= new Promise((resolve, reject) => {
            const req = indexedDB.open("sift", 3);
            req.onupgradeneeded = (event) => {
                const db = req.result;
                if (event.oldVersion < 1) {
                    db.createObjectStore("log", { autoIncrement: true }).createIndex("t", "t");
                    db.createObjectStore("labels"); // your keep/hide corrections, keyed by post ID
                }
                if (!db.objectStoreNames.contains("seen")) db.createObjectStore("seen", { keyPath: "id" }).createIndex("seenAt", "seenAt");
                if (!db.objectStoreNames.contains("scores")) db.createObjectStore("scores").createIndex("t", "t"); // post ID → { scores, t, photo }
            };
            req.onsuccess = () => {
                const db = req.result;
                db.onversionchange = () => {
                    db.close();
                    opening = undefined;
                };
                db.onclose = () => (opening = undefined);
                resolve(db);
            };
            req.onerror = () => {
                opening = undefined;
                reject(req.error);
            };
            req.onblocked = () => console.warn("Xift: the database upgrade waits for another Xift page to close");
        });
        return opening;
    }

    const done = (req) => new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

    const finished = (tx) => new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });

    async function store(mode, name = "log") {
        return (await open()).transaction(name, mode).objectStore(name);
    }

    // Deletes up to count of the oldest seen posts, inside the caller's transaction. Resolves to how many went.
    function deleteOldest(seen, count) {
        return new Promise((resolve, reject) => {
            if (!(count > 0)) return resolve(0);
            let gone = 0;
            const req = seen.index("seenAt").openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor || gone === count) return resolve(gone);
                cursor.delete();
                gone++;
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }

    // A correction is { wanted, steps }: the threshold changes a hide made, so a later keep can take them back.
    // Corrections stored before 0.2.3 are just the wanted string.
    const correction = (value) => (typeof value === "string" ? { wanted: value, steps: [] } : value);

    globalThis.SiftDB = {
        add: async (entry) => done((await store("readwrite")).add(entry)),
        since: async (t) => done((await store("readonly")).index("t").getAll(IDBKeyRange.lowerBound(t))),
        all: async () => done((await store("readonly")).getAll()),
        // The log and the saved scores; corrections stay.
        clear: async () => {
            const tx = (await open()).transaction(["log", "scores"], "readwrite");
            tx.objectStore("log").clear();
            tx.objectStore("scores").clear();
            return finished(tx);
        },
        setLabel: async (id, wanted, steps = []) => done((await store("readwrite", "labels")).put({ wanted, steps }, id)),
        getLabel: async (id) => correction(await done((await store("readonly", "labels")).get(id))),

        getSeen: async (id) => done((await store("readonly", "seen")).get(String(id))),
        // Saves a seen post. With trimTo, the oldest beyond that number go in the same transaction (at most 1,000).
        putSeen: async (record, trimTo = null) => {
            const tx = (await open()).transaction("seen", "readwrite");
            const seen = tx.objectStore("seen");
            seen.put(record);
            if (trimTo !== null) await deleteOldest(seen, Math.min((await done(seen.count())) - trimTo, 1000));
            return finished(tx);
        },
        // Deletes the oldest seen posts until at most limit remain, 1,000 per transaction, so lookups aren't held up.
        trimSeen: async (limit) => {
            for (;;) {
                const tx = (await open()).transaction("seen", "readwrite");
                const seen = tx.objectStore("seen");
                const over = (await done(seen.count())) - limit;
                const gone = await deleteOldest(seen, Math.min(over, 1000));
                await finished(tx);
                if (over <= 1000 || gone === 0) return;
            }
        },
        // Up to n seen posts with seenAt at or before `before`, newest first. A post at exactly `before` may come
        // again in the next batch: the Seen list drops repeats by ID.
        seenBatch: async (before, n) => {
            const index = (await store("readonly", "seen")).index("seenAt");
            return new Promise((resolve, reject) => {
                const out = [];
                const req = index.openCursor(IDBKeyRange.upperBound(before), "prev");
                req.onsuccess = () => {
                    const cursor = req.result;
                    if (!cursor || out.length >= n) return resolve(out);
                    out.push(cursor.value);
                    cursor.continue();
                };
                req.onerror = () => reject(req.error);
            });
        },
        seenSince: async (after) => done((await store("readonly", "seen")).index("seenAt").getAll(IDBKeyRange.lowerBound(after, true))),
        countSeen: async () => done((await store("readonly", "seen")).count()),

        getScores: async (id) => done((await store("readonly", "scores")).get(String(id))),
        // photo: Jev saw the post's photo with its text. model: the Ollama model that gave them, or null for Jev.
        putScores: async (id, scores, t, photo = false, model = null) => done((await store("readwrite", "scores")).put({ scores, t, photo, model }, String(id))),
        clearScores: async () => done((await store("readwrite", "scores")).clear()),
        // Deletes the scores saved before `before`.
        trimScores: async (before) => trimBefore("scores", before),
        // Deletes the judging entries written before `before`. Your keeps and hides and the threshold changes stay:
        // they're few, and they're the record of what Xift learnt.
        trimLog: async (before) => trimBefore("log", before, (entry) => entry.type !== "label" && entry.type !== "learn"),
        clearSeen: async () => done((await store("readwrite", "seen")).clear()),
    };

    // Deletes a store's records whose t is before `before`, by its t index, those that pass `drop` if given.
    async function trimBefore(name, before, drop = () => true) {
        const tx = (await open()).transaction(name, "readwrite");
        const req = tx.objectStore(name).index("t").openCursor(IDBKeyRange.upperBound(before, true));
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return;
            if (drop(cursor.value)) cursor.delete();
            cursor.continue();
        };
        return finished(tx);
    }
})();
