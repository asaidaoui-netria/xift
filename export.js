// Downloads the whole Xift log as JSON. Runs in a tab because a popup can close mid-download.
(async () => {
    const status = document.getElementById("status");
    try {
        const entries = await SiftDB.all();
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([JSON.stringify(entries)], { type: "application/json" }));
        link.download = `sift-log-${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        status.textContent = `Exported ${entries.length} entries. You can close this tab.`;
    } catch (err) {
        status.textContent = `Export failed: ${err}`;
    }
})();
