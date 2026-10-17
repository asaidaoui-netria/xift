# Xift

A Firefox add-on that clears the noise from your X timeline. X's search and lists decide the topic. Xift asks [Jev](https://openrouter.ai/docs/guides/community/jev), TypeSafe's decision model, four questions about each post, with its first photo if it has one:
- Is it engagement bait?
- Is it rage bait?
- Is it low on substance?
- Is it self-promotion?

A post that crosses any of your thresholds collapses to a one-line bar saying why, for example "Rage bait 0.90". It stays in the feed:
- **Show** opens it for a look.
- **Keep** opens it and tells Xift it was wrong.
- **Hide** appears when you hover over a post Xift judged. It collapses the post and tells Xift it should have. After **Show**, the same spot also offers **Keep**.

Ads, and posts with too little text and no photo to judge, collapse too. Each has a switch.

**Replies:** on a post's own page, the replies below it are judged the same way. The post itself, the posts above it and its author's replies show as X has them, even an answer to a collapsed reply; someone else's reply joined to a collapsed one is hidden with it. Posts X recommends below the replies are judged too when they're newer than the post. A switch in the popup turns this off.

**Seen posts:** Home skips the posts you've already read, each as a thin "Seen" bar with a Show button. A post counts as read after a second as focus mode's current post, or, with focus mode off, after a second on screen before you scroll past it. Pressing j to leave a post, or opening it, counts too. Search and lists show everything. The Seen tile in the popup opens what you've read, drawn like X's timeline, with search.

**Always show:** after Show on a collapsed post, the person button under its avatar adds its author to your Always show list. Their posts then always show and are never sent to Jev, so they cost nothing. Ads still collapse, ⊘ still hides one of their posts, and Home still skips their posts you've read. The popup lists them, with × to remove one and a field to add one by handle.

## The popup

Xift's button opens one screen. At the top: the on/off switch, a status line that says what Xift is doing and offers the fix when something's wrong (reset the spending or raise the limit, enter the key), and three tiles: focus mode, judging replies, and the Seen list. Below, four tabs: **Today** (posts sifted out today and why, and what Xift has spent), **Sensitivity** (the four thresholds), **Always show**, and **Settings**. Rest the pointer on anything to see what it means.

## What it costs

Each post Jev judges costs about $0.000026, so about 3 cents per 1,000 posts. A post with a photo costs about $0.00007.
- **Saved scores:** Xift keeps Jev's scores for each post for 7 days. A reload, a new tab or the same post in another search uses them instead of paying again, and your thresholds still apply as they move. Updating Xift clears them, since a new version may ask Jev different questions.
- **Spending:** the popup shows about how much Xift has spent this month, since the 1st or since you last pressed Reset if that was later (hover over it for today). It adds up the cost OpenRouter reports for each call; calls that time out or fail aren't counted.
- **Spending limit:** $1 a month to start with (about 38,000 posts); change it in the popup's Settings, or empty the field for none. When the month's spending reaches it, Xift stops calling Jev until the 1st, or until you reset the spending or raise the limit. Posts it judged in the last 7 days still collapse from their saved scores; the others show unfiltered. The toolbar button shows a grey **$** meanwhile.

## Keys

On the home timeline, search and lists (j, k and h also on a post's page):
- **j / k** move to the next or previous open post, skipping bars. X's own keys, such as l to like and Enter to open, act on the post you're on.
- **h** hides the post you're on, like ⊘, and moves on.
- **1–9** pick the page's tabs from the left: on Home, 1 is For you and 2 is Following; on search, 1 is Top and 2 is Latest. This works on every X page with tabs. Pressing the tab you're on does nothing.
- **f** turns focus mode on and off: one post at a time, wider and centred, with the other posts and both side columns out of the way. j and k move between posts, and the wheel reads on: once you've scrolled past a post, the next one takes its place. Hold **⌥** to see X's normal layout for a moment. The popup sets the width (760 px, 900 px or Fill) and the text size (X's, 17 px or 19 px). It needs a window at least 904 px wide.

On every X page:
- **e** expands **Show more** on the post you're on. With no post picked, it expands the top post on screen that has one.
- **⌫** (delete) goes back, like X's ← arrow: from a post you opened with Enter or a click, it returns you to where you were. Pages without the arrow, such as Home, ignore it.
- **t** opens X's Repost menu (Repost, Quote) on the post you're on, and closes it again. Escape closes it too, but in full screen Firefox takes the first Escape to leave full screen.

To open a bar from the keyboard, Tab to its buttons.

X's left menu is hidden until you need it, on every X page. The X logo and the column stay, so the timeline doesn't move. The menu slides in when you hover over its column, Tab into it, or hold **⌥**. While you hold ⌥, each item shows its number, and **⌥ + number** opens it:

| ⌥+ | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 0 |
|---|---|---|---|---|---|---|---|---|---|---|
| | Home | Explore | Notifications | Follow | Chat | Calls | Grok | History | Profile | Post |

The numbers are fixed, so they don't shift when X adds an item or folds one into More. History and Profile fold into More in short windows; their keys do nothing then. Unread counts hide with the menu; the tab title still shows them.

X's right column (search box, trends, news, Who to follow) is hidden the same way. It slides in when you hover over it, Tab into it, or hold **⌥**, alongside the menu. **⌥ + click** works on anything in it. X's **/** still opens the search box, and the column shows while you type; **Esc** hides it again. The floating Grok and Chat buttons stay.

## It learns from you

Every keep and hide moves the threshold behind it by a small step:
- Keep a collapsed rage-bait post, and Xift gets more tolerant of rage bait.
- Hide an open post that was nearly bait, and Xift gets stricter about bait.
- A post far from every threshold teaches nothing. You probably hid it for its topic, which X's search handles.
- Keep a post you hid by mistake, and Xift takes back the step that hide made.
- Keep and Hide on a post judged with its photo don't move the thresholds yet. With a photo, Jev's engagement-bait scores run about 0.10 higher than the text-only scores the thresholds learned from.

You can also drag the four sliders in the popup, or reset them to the defaults.

## Install

You need Firefox 140 or later and an [OpenRouter API key](https://openrouter.ai/settings/keys). Use a dedicated key with a small credit limit.

- **To try it:** run `npx --yes web-ext@10.7.0 run` in this folder. Firefox opens with a separate development profile at `~/.sift-dev-profile`, which keeps its login and settings.
- **To sign it for regular Firefox:**
  1. Bump `version` in `manifest.json`.
  2. Run `WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… npx --yes web-ext@10.7.0 sign` with your addons.mozilla.org API keys.
  3. Install the `.xpi` from `web-ext-artifacts/`.

Then click Xift's button in the toolbar: if it asks for access to x.com, allow it, then paste the key into the field in its status line.

## Run it on your Mac

Xift can ask a decision model running in [Ollama](https://ollama.com) on your own computer instead of Jev. Then it needs no key, costs nothing, and posts never leave your computer.

1. Install Ollama 0.35 or later and pull a decision model: `ollama pull tev1:4b`. [Ollama's list](https://ollama.com/search?c=decision) has the others. In one test on a MacBook Pro with an M4 and 16 GB, scrolling X for 10 minutes per model, `tev1:4b` took about 3 s a post and about 10 GB of memory, so 4 in 10 posts on screen were still waiting for a verdict: one that arrives after you've scrolled past a post leaves it open. `tev1:0.8b` kept up, at under 1 s, but called neutral posts rage bait. Neither caught the empty one-liners Jev catches, and Jev takes about 0.3 s. `clef-flash` also reads photos, but it needs 11.5 GB of graphics memory, more than macOS gives Ollama on a 16 GB Mac. Raising that limit (`sudo sysctl iogpu.wired_limit_mb=12800`, until the next restart) lets it load, but it then took 9 to 78 s a photo post.
2. Start Ollama so that it accepts add-ons: `OLLAMA_ORIGINS="moz-extension://*" ollama serve`. With the Ollama app, run `launchctl setenv OLLAMA_ORIGINS "moz-extension://*"` once and restart the app. Without this, Ollama refuses Xift with a 403, and Firefox gives it no way around that. The setting lets any add-on you've installed use Ollama.
3. In the popup's Settings, set **Model** to **Local** and type the model's name as you pulled it.

Each model scores on its own scale, so each keeps its own thresholds. Switching models keeps what each one learnt, and saved scores are reused only by the model that gave them. With a model that can't see photos, a post with a photo is judged on its text; one with too little text to judge stays open. The spending limit doesn't apply.

## What leaves your browser

- **With Local:** posts go to Ollama on your computer, and nothing goes to OpenRouter. With `clef-flash`, the photo is fetched from X's image server as below.

- **What is sent:** on the home timeline, search, lists and the replies on a post's page, each post Xift judges goes to OpenRouter, which passes it to TypeSafe: its author's name and handle, its text, any quoted post's text, the image descriptions of its photos and the quoted post's, and its first photo. Every request asks OpenRouter to use only providers that don't collect data (`data_collection: "deny"`).
- **Photos:** Xift's background fetches the photo from X's image server (X sees that request, as it sees your browser load the photo), shrinks or pads it to the 280 to 1,568 px Jev reads, and sends it as a JPEG. Re-encoding drops the photo's metadata, such as its location.
- **What isn't sent:**
  - ads
  - posts from protected accounts
  - posts with too little text and no photo
  - a post's other photos, a quoted post's photos, videos and GIFs, and photos X shows blurred as sensitive
  - a public post quoting a protected account's post
  - thread replies shown under the post they answer, which follow that post (except under a post Home skipped as seen, where a reply is judged on its own)
  - on a post's page: the post itself, the posts above it, and its author's replies
  - anything from other pages
- **TypeSafe's policy for Jev:** its [privacy policy](https://typesafe.ai/privacy) (last updated 19 November 2025) says it won't train or fine-tune models on your input. It keeps data "as long as reasonably necessary to provide you with the Services, or otherwise in support of our business or commercial purposes". It runs in the US.
- **Private windows:** if you let Xift run in private windows, their posts are still judged and sent as above, but nothing about what you read there is kept: no log, saved scores, corrections, learning or Seen list. What the calls cost still counts toward your spending limit, and an author you add to Always show there is saved as anywhere else.
- **Your key** is stored unencrypted in your Firefox profile.
  - If your credit runs out, Xift shows "!" and stops calling.
  - After you top up, paste the key again to resume.
- **The log** stays on your machine, in the add-on's own storage. It records each judged post's ID, scores and verdict, your keep and hide clicks, and every threshold change. It never records post text. Judging entries older than 90 days are deleted; your keeps, hides and threshold changes stay.
  - Firefox's "Clear recent history" doesn't delete it.
  - Uninstalling Xift does, so use Export (in the popup's Settings) first.
  - Jev's scores for each judged post (its ID and the four scores) are also saved for 7 days, to avoid paying twice. Clear (the log, in Settings) deletes them too, so posts on your next reload are paid for again.
- **Report a problem** (in the popup's Settings → Help) copies Xift's and Firefox's versions, the status line, your switches and your thresholds to the clipboard, and opens GitHub's issue form. Xift sends nothing itself: the details reach GitHub only if you paste them into the form and submit it.
- **Your Always show list** is a list of handles, kept in your Firefox profile. It's never sent anywhere.
- **The Seen list** is a local history of what you read. It stays on your machine, in the add-on's own storage.
  - For each post you read on Home, search or a list, it keeps the author's name and handle, the text, the image descriptions, and links to the avatar and images, up to the limit you set in the popup (10,000 posts by default).
  - Firefox's "Clear recent history" doesn't delete it, and the log's Export doesn't include it. Uninstalling Xift deletes it, and so does "Clear Seen list" at the bottom of the list.
  - Clearing the log and clearing the Seen list don't touch each other's data.
  - Opening the list loads its images from X's servers, so X sees your address when you open it.

## Problems and ideas

In the popup, go to Settings → Help:

- **Report a problem** copies Xift's details (versions, status, switches, thresholds; never your key or what you read) and opens [GitHub's issue form](https://github.com/asaidaoui-netria/xift/issues/new?template=bug.yml). Paste them in, say what happened, and submit. When Xift has stopped or Jev refused a post, the status line has a Report button too.
- **Suggest a feature** opens [the form for ideas](https://github.com/asaidaoui-netria/xift/issues/new?template=feature.yml).

Both need a GitHub account, and issues are public. Report a security problem [privately](https://github.com/asaidaoui-netria/xift/security/advisories/new) instead.

## Known limits

- **One photo.** Jev sees a post's first photo with its text, not its other photos, videos, GIFs or a quoted post's photos. A post whose photo X hasn't shown within 3 s is judged on its text alone.
- **Local thresholds** start from 16 invented posts, not from posts you've judged. Expect to move them, or let your Keeps and Hides move them.
- **Photos and learning.** Scores with a photo run higher on engagement bait than text-only ones, and the thresholds learned from text-only scores. Until that is calibrated, photo posts don't teach Xift.
- **X changes its page markup** from time to time, which breaks post detection until the selectors at the top of `content.js` are updated.
- **Learning is per quality, not per author or topic.**
- **Prompt injection.** A post can contain text, or a photo of text, written to fool the model. Each post is judged on its own, so a successful attempt affects only that post's verdict. If you then Keep it, the thresholds it crossed loosen by one step, as for any Keep (unless Jev judged it with its photo: those don't teach yet).
- **Focus mode** hides Xift's bars too, so Show and Keep need ⌥. X's **/** does nothing there, because the search box is in the hidden column: hold ⌥ and click it instead.

## Development

- `node --test` runs the unit tests.
- `npx --yes web-ext@10.7.0 lint` checks the add-on.
- In the add-on's console (about:debugging → Xift → Inspect), `browser.storage.local.set({ dummy: true })` swaps Jev for random verdicts, for checking page behaviour without spending credit. It works only in a development install: `web-ext run`, or a temporary add-on loaded in about:debugging.

## Credits

- **[Control Panel for Twitter](https://github.com/insin/control-panel-for-twitter)** (MIT, © 2019 Jonny Buchanan): `isReplyToPrevious` in `content.js` is adapted from it, and the way Xift detects ads and hides a timeline cell's content follows it.
- **[Bouncer](https://github.com/imbue-ai/bouncer)** (AGPL-3.0): the idea of deferring changes for posts above the viewport came from it. No Bouncer code is used.

## Licence

MIT. See `LICENSE`.
