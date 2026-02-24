'use strict';

/**
 * DailyTasksQuest - Automates Microsoft Rewards daily tasks, quizzes, and activities.
 *
 * Answers are RANDOMIZED to avoid always picking option "A" / index 0, which is
 * obviously bot-like. Each activity type uses its own randomization strategy.
 *
 * Supported activity types:
 *   - Standard multiple-choice quiz  (rqAnswerOption0..N)
 *   - Lightning / Super quiz         (rqAnswerOption0..N with multi-round flow)
 *   - "This or That" / binary poll   (rqAnswerOption0, rqAnswerOption1)
 *   - Daily poll                     (radio / image options)
 *   - Open-link ("Visit a site")     single click, no answer needed
 *   - Streak card                    single click to collect
 */
class DailyTasksQuest {
    constructor() {
        this._jobStatus_        = STATUS_NONE;
        this._completedToday    = [];
        this._failedToday       = [];
        this._activeTabId       = null;
        this._randomizeAnswers  = true;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    get jobStatus() { return this._jobStatus_; }

    reset() {
        this._jobStatus_     = STATUS_NONE;
        this._completedToday = [];
        this._failedToday    = [];
        this._activeTabId    = null;
    }

    /**
     * Main entry point called by background.js.
     * Guards against double-runs and respects the enable flag.
     */
    async doWork() {
        const settings = await chrome.storage.sync.get({
            enableDailyTasks:  false,
            randomizeAnswers:  true,
            dailyTaskDelay:    0        // minutes of extra random delay offset
        });

        if (!settings.enableDailyTasks) {
            console.log('[DailyTasks] Disabled in settings, skipping.');
            return;
        }

        this._randomizeAnswers = settings.randomizeAnswers !== false; // default true

        // Guard: already ran today?
        const today = new Date().toDateString();
        const stored = await chrome.storage.local.get(['dailyTasksDate', 'dailyTasksDone']);
        if (stored.dailyTasksDate === today && stored.dailyTasksDone) {
            console.log('[DailyTasks] Already completed today, skipping.');
            this._jobStatus_ = STATUS_DONE;
            return;
        }

        // Guard: already running
        if (this._jobStatus_ === STATUS_BUSY) {
            console.log('[DailyTasks] Already running, skipping duplicate call.');
            return;
        }

        // Optional random delay offset to make timing less predictable
        const delayMinutes = settings.dailyTaskDelay || 0;
        if (delayMinutes > 0) {
            const jitter = Math.random() * delayMinutes * 60 * 1000;
            console.log(`[DailyTasks] Waiting ${Math.round(jitter / 1000)}s before starting...`);
            await this._sleep(jitter);
        }

        console.log('[DailyTasks] Starting daily tasks automation...');
        this._jobStatus_ = STATUS_BUSY;

        try {
            await this._runAllActivities();

            await chrome.storage.local.set({
                dailyTasksDate: today,
                dailyTasksDone: true,
                dailyTasksLastRun: new Date().toISOString(),
                dailyTasksCompleted: this._completedToday.length,
                dailyTasksFailed:    this._failedToday.length
            });

            console.log(`[DailyTasks] Done. Completed: ${this._completedToday.length}, Failed: ${this._failedToday.length}`);
            this._jobStatus_ = STATUS_DONE;

        } catch (err) {
            console.error('[DailyTasks] Fatal error:', err);
            this._jobStatus_ = STATUS_ERROR;
        } finally {
            await this._closeActiveTab();
        }
    }

    // ── Activity runner ───────────────────────────────────────────────────────

    async _runAllActivities() {
        const tabId = await this._openTab('https://rewards.bing.com/');
        this._activeTabId = tabId;

        await this._waitMs(4000); // let the SPA fully render

        // Fetch the list of pending activities from the page
        const activities = await this._getActivities(tabId);
        console.log(`[DailyTasks] Found ${activities.length} pending activities.`);

        if (activities.length === 0) {
            console.log('[DailyTasks] No pending activities found – page may require login.');
            return;
        }

        // Shuffle the order so we don't always start with the same activity
        const shuffled = this._shuffleArray([...activities]);

        for (const activity of shuffled) {
            // Variable inter-activity delay: 8–25 seconds
            const preDelay = 8000 + Math.random() * 17000;
            await this._waitMs(preDelay);

            try {
                await this._completeActivity(activity);
                this._completedToday.push(activity.id || activity.title);
            } catch (err) {
                console.warn(`[DailyTasks] Activity "${activity.title}" failed:`, err.message);
                this._failedToday.push(activity.id || activity.title);
            }
        }
    }

    // ── Page scraping (runs inside the rewards hub tab) ───────────────────────

    async _getActivities(tabId) {
        const result = await this._execInTab(tabId, () => {
            const acts = [];

            // Helper to push a card if not already completed
            const pushCard = (el) => {
                if (!el) return;
                // Skip cards that show as completed (checked icon, "complete" class, full progress ring)
                const isComplete =
                    el.classList.contains('ds_card_complete') ||
                    el.classList.contains('mee-icon-AddMedium') ||
                    el.querySelector('.ds_punchcard_ctaImgComplete') !== null ||
                    el.querySelector('[class*="complete"]') !== null;

                if (isComplete) return;

                const linkEl   = el.querySelector('a[href]');
                const titleEl  = el.querySelector('.ds_card_sec_title, .c_card_title, .mee-card-header, h3, h4');
                const pointsEl = el.querySelector('[class*="points"], .ds_punchcard_points, .mee-card-section-label');
                const typeAttr = el.getAttribute('data-bi-id') || el.getAttribute('data-m') || '';

                if (!linkEl) return;

                acts.push({
                    title:  (titleEl  && titleEl.textContent.trim())  || 'Unknown',
                    url:    linkEl.href,
                    points: (pointsEl && pointsEl.textContent.trim()) || '0',
                    type:   typeAttr
                });
            };

            // Daily-set cards
            document.querySelectorAll('.ds_card:not(.ds_card_complete), .ds_completable')
                    .forEach(pushCard);

            // More-activities / punch-card / bonus cards
            document.querySelectorAll(
                '.mee-card, .c_card, [data-bi-id*="activity"], [class*="quest"]'
            ).forEach(pushCard);

            // Deduplicate by URL
            const seen = new Set();
            return acts.filter(a => {
                if (seen.has(a.url)) return false;
                seen.add(a.url);
                return true;
            });
        });

        return result || [];
    }

    // ── Single-activity dispatcher ────────────────────────────────────────────

    async _completeActivity(activity) {
        console.log(`[DailyTasks] Attempting: "${activity.title}" → ${activity.url}`);

        const url = activity.url;

        // Open the activity URL in the existing tab (reuse to look natural)
        await chrome.tabs.update(this._activeTabId, { url });
        await this._waitMs(4000); // let the activity page load

        // Detect the activity type from its URL / content
        const actType = await this._detectActivityType(this._activeTabId, url);
        console.log(`[DailyTasks] Activity type detected: ${actType}`);

        switch (actType) {
            case 'quiz':
            case 'lightning':
            case 'supersonic':
                await this._completeMultiChoiceQuiz(this._activeTabId);
                break;

            case 'poll':
            case 'thisorthat':
                await this._completePoll(this._activeTabId);
                break;

            case 'openlink':
            case 'streak':
                // Just visiting / clicking the page is sufficient
                await this._waitMs(3000);
                break;

            default:
                // Unknown – try the generic multi-choice path as a best-effort
                console.log('[DailyTasks] Unknown type, attempting generic quiz path...');
                await this._completeMultiChoiceQuiz(this._activeTabId).catch(() => {});
                break;
        }

        console.log(`[DailyTasks] Finished: "${activity.title}"`);
    }

    async _detectActivityType(tabId, url) {
        const lurl = url.toLowerCase();

        if (lurl.includes('quiz'))          return 'quiz';
        if (lurl.includes('lightning'))     return 'lightning';
        if (lurl.includes('supersonic'))    return 'supersonic';
        if (lurl.includes('poll'))          return 'poll';
        if (lurl.includes('thisorthat'))    return 'thisorthat';
        if (lurl.includes('streakbonus'))   return 'streak';
        if (lurl.includes('openlink'))      return 'openlink';

        // Fall back to inspecting the page DOM
        const result = await this._execInTab(tabId, () => {
            if (document.querySelector('#rqAnswerOption0'))         return 'quiz';
            if (document.querySelector('.rqOption'))                return 'quiz';
            if (document.querySelector('[id^="btoption"]'))         return 'poll';
            if (document.querySelector('.b_vList .b_slideInput'))   return 'poll';
            return 'unknown';
        });

        return result || 'unknown';
    }

    // ── Multiple-choice quiz (standard, lightning, supersonic) ────────────────

    /**
     * Core randomization happens here.
     * We enumerate all visible answer options and pick one at random –
     * never always index 0 / "option A".
     */
    async _completeMultiChoiceQuiz(tabId) {
        const MAX_QUESTIONS = 30; // Safety cap
        let questionsSeen   = 0;

        for (let q = 0; q < MAX_QUESTIONS; q++) {

            // Wait for an answer option to appear
            const optionsFound = await this._waitForElement(tabId, '[id^="rqAnswerOption"], .rqOption', 6000);
            if (!optionsFound) {
                console.log('[DailyTasks] No more question options found, quiz may be complete.');
                break;
            }

            // ── RANDOMIZE: pick a random answer ─────────────────────────────
            const clicked = await this._execInTab(tabId, (randomize) => {
                // Collect all visible, enabled answer options
                const byId = Array.from(
                    document.querySelectorAll('[id^="rqAnswerOption"]')
                ).filter(el => !el.disabled && el.offsetParent !== null);

                const byClass = Array.from(
                    document.querySelectorAll('.rqOption')
                ).filter(el => !el.disabled && el.offsetParent !== null && !el.classList.contains('rqOptionUsed'));

                // Prefer ID-based options; fall back to class-based
                const options = byId.length > 0 ? byId : byClass;

                if (options.length === 0) return false;

                let chosenIndex;
                if (randomize) {
                    // TRUE randomization: any index with equal probability
                    chosenIndex = Math.floor(Math.random() * options.length);
                } else {
                    chosenIndex = 0; // forced non-random (debug/testing only)
                }

                console.log(
                    `[DailyTasks injected] Clicking option ${chosenIndex + 1}/${options.length}` +
                    ` (id="${options[chosenIndex].id || ''}")`
                );
                options[chosenIndex].click();
                return true;
            }, this._randomizeAnswers);

            if (!clicked) {
                console.log('[DailyTasks] Could not click option, stopping quiz loop.');
                break;
            }

            questionsSeen++;

            // Short pause between answer click and next question rendering (2-4 s)
            await this._waitMs(2000 + Math.random() * 2000);

            // Check for a "Next" / "Submit" button and click it if present
            await this._clickNextIfPresent(tabId);

            // Brief pause before hunting for the next question
            await this._waitMs(1500 + Math.random() * 1000);

            // Has the quiz concluded? Look for a results/completion element
            const isDone = await this._execInTab(tabId, () => {
                return !!(
                    document.querySelector('#quizCompleteContainer') ||
                    document.querySelector('.rq_completion') ||
                    document.querySelector('.b_hide[id="rqAnswerOption0"]') ||
                    document.querySelector('[class*="complete"]')
                );
            });

            if (isDone) {
                console.log(`[DailyTasks] Quiz complete after ${questionsSeen} question(s).`);
                break;
            }
        }
    }

    async _clickNextIfPresent(tabId) {
        await this._execInTab(tabId, () => {
            const selectors = [
                '#rqBtnNext',
                '.rq_button:not([disabled])',
                '.b_primBtn:not([disabled])',
                '[id="btnNext"]:not([disabled])',
                'button[class*="next"]:not([disabled])'
            ];
            for (const sel of selectors) {
                const btn = document.querySelector(sel);
                if (btn && btn.offsetParent !== null) {
                    btn.click();
                    return true;
                }
            }
            return false;
        });
    }

    // ── Poll / This-or-That  ──────────────────────────────────────────────────

    /**
     * Polls have no right/wrong answer – we still randomize to vary the data.
     */
    async _completePoll(tabId) {
        const clicked = await this._execInTab(tabId, (randomize) => {
            // "This or That" and image polls use btoption IDs
            const btOptions = Array.from(
                document.querySelectorAll('[id^="btoption"], [class*="btOption"]')
            ).filter(el => el.offsetParent !== null);

            // Standard text polls use radio buttons inside a list
            const radioOptions = Array.from(
                document.querySelectorAll('.b_vList input[type="radio"], .b_vList .b_slideInput')
            ).filter(el => el.offsetParent !== null);

            // Image-based poll tiles
            const tileOptions = Array.from(
                document.querySelectorAll('.rqOption, .taskCard, [class*="pollOption"]')
            ).filter(el => el.offsetParent !== null);

            const pool = btOptions.length   > 0 ? btOptions   :
                         radioOptions.length > 0 ? radioOptions :
                         tileOptions;

            if (pool.length === 0) return false;

            const idx = randomize ? Math.floor(Math.random() * pool.length) : 0;
            console.log(`[DailyTasks injected] Poll: clicking option ${idx + 1}/${pool.length}`);
            pool[idx].click();
            return true;
        }, this._randomizeAnswers);

        if (!clicked) {
            console.warn('[DailyTasks] No poll options found.');
            return;
        }

        await this._waitMs(2000 + Math.random() * 1500);

        // Submit the poll if there is a submit button
        await this._execInTab(tabId, () => {
            const submit = document.querySelector(
                '#rqBtnNext, .rq_button, .b_primBtn, button[type="submit"]'
            );
            if (submit && submit.offsetParent !== null) submit.click();
        });

        await this._waitMs(2000);
    }

    // ── Utilities ─────────────────────────────────────────────────────────────

    /** Wait for a CSS selector to appear on the page (polls until timeout). */
    async _waitForElement(tabId, selector, timeoutMs = 5000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const found = await this._execInTab(tabId, (sel) => {
                const el = document.querySelector(sel);
                return !!(el && el.offsetParent !== null);
            }, selector);
            if (found) return true;
            await this._waitMs(500);
        }
        return false;
    }

    async _waitMs(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async _sleep(ms) { return this._waitMs(ms); }

    /** Open a new (non-active) tab and return it. */
    async _openTab(url) {
        const tab = await chrome.tabs.create({ url, active: false });
        // Wait for the tab to finish loading
        await new Promise((resolve) => {
            const listener = (tabId, changeInfo) => {
                if (tabId === tab.id && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
            // Safety timeout
            setTimeout(resolve, 10000);
        });
        return tab;
    }

    async _closeActiveTab() {
        if (this._activeTabId !== null) {
            try { await chrome.tabs.remove(this._activeTabId); } catch (_) {}
            this._activeTabId = null;
        }
    }

    /**
     * Execute a function inside the given tab via chrome.scripting.executeScript.
     * @param {number}   tabId
     * @param {Function} fn       - function to inject (must be self-contained)
     * @param {...*}     args     - serialisable arguments passed to fn
     * @returns {*} The return value of fn
     */
    async _execInTab(tabId, fn, ...args) {
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId },
                func:   fn,
                args
            });
            return results && results[0] ? results[0].result : null;
        } catch (err) {
            console.warn('[DailyTasks] executeScript error:', err.message);
            return null;
        }
    }

    /**
     * Fisher-Yates shuffle – returns a new shuffled copy of the array.
     */
    _shuffleArray(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }
}
