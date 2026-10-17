// web-ext settings for Xift: what to leave out of the package, the dev profile, and unlisted signing.
import { homedir } from "node:os";

export default {
    ignoreFiles: ["docs", "*.test.js", "web-ext-config.mjs", "README.md"],
    run: {
        // A dedicated profile that keeps X's login, the key and the log between runs. Never the daily profile.
        firefoxProfile: `${homedir()}/.sift-dev-profile`,
        profileCreateIfMissing: true,
        keepProfileChanges: true,
        startUrl: ["https://x.com/home"],
    },
    sign: { channel: "unlisted" },
};
