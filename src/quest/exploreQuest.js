'use strict';

/**
 * ExploreQuest - Automates "Explore on Bing" weekly/monthly tasks.
 *
 * These tasks appear in the Microsoft Rewards dashboard as cards with an
 * hourglass icon (not yet activated) or a + icon (activated, ready to earn).
 * Each card requires:
 *   1. Activation - visiting the task's destination/activation URL.
 *   2. A single Bing search with a relevant keyword to earn points.
 *
 * The class fetches MorePromotions from the Rewards flyout API, filters to
 * incomplete search-type tasks, activates them, and then performs the
 * associated Bing searches using the same fetch-based mechanism as SearchQuest.
 */
class ExploreQuest {
    constructor() {
        this._jobStatus_ = STATUS_NONE;
        this._tasks_ = [];           // Loaded tasks from API
        this._completedThisRun_ = 0; // Tasks completed in the current run
        this._lastFetchTime_ = null;
        this._errors_ = [];
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    get jobStatus() {
        return this._jobStatus_;
    }

    get completedThisRun() {
        return this._completedThisRun_;
    }

    get tasks() {
        return this._tasks_;
    }

    /**
     * Resets the in-memory run state so doWork() can be called again.
     * Storage-based completion records are preserved (weekly deduplication).
     */
    reset() {
        this._jobStatus_ = STATUS_NONE;
        this._tasks_ = [];
        this._completedThisRun_ = 0;
        this._errors_ = [];
        console.log('ExploreQuest: reset');
    }

    /**
     * Main entry point. Fetches tasks, activates them, searches for them.
     * @returns {Promise<{success: boolean, completed: number, total: number}>}
     */
    async doWork() {
        console.log('ExploreQuest.doWork() starting...');
        this._jobStatus_ = STATUS_BUSY;
        this._completedThisRun_ = 0;
        this._errors_ = [];

        try {
            // Check if explore tasks are enabled in settings
            const settings = await chrome.storage.sync.get({ enableExploreTasks: true });
            if (!settings.enableExploreTasks) {
                console.log('ExploreQuest: disabled in settings, skipping');
                this._jobStatus_ = STATUS_DONE;
                return { success: true, completed: 0, total: 0, skipped: true };
            }

            // Fetch available tasks from the Rewards API
            const tasks = await this._fetchExploreTasks();
            this._tasks_ = tasks;

            if (!tasks || tasks.length === 0) {
                console.log('ExploreQuest: No incomplete explore tasks found');
                this._jobStatus_ = STATUS_DONE;
                return { success: true, completed: 0, total: 0 };
            }

            console.log(`ExploreQuest: Found ${tasks.length} task(s) to process`);

            // Process each task sequentially  
            for (const task of tasks) {
                if (this._jobStatus_ !== STATUS_BUSY) break;

                try {
                    const result = await this._processTask(task);
                    if (result) {
                        this._completedThisRun_++;
                        console.log(`ExploreQuest: Completed task "${task.title}" (${this._completedThisRun_}/${tasks.length})`);
                    }
                } catch (taskError) {
                    console.error(`ExploreQuest: Error processing task "${task.title}":`, taskError);
                    this._errors_.push({ task: task.title, error: taskError.message });
                }

                // Human-like gap between tasks: 15–45 seconds.
                // A fixed 3 s interval is trivially detectable; a large random
                // window looks much more like organic browsing behaviour.
                if (tasks.indexOf(task) < tasks.length - 1) {
                    const gapMs = Math.floor(15000 + Math.random() * 30000);
                    console.log(`ExploreQuest: Waiting ${Math.round(gapMs / 1000)}s before next task...`);
                    await this._sleep(gapMs);
                }
            }

            this._jobStatus_ = STATUS_DONE;
            console.log(`ExploreQuest.doWork() completed. Processed ${this._completedThisRun_}/${tasks.length} tasks.`);
            return {
                success: true,
                completed: this._completedThisRun_,
                total: tasks.length,
                errors: this._errors_
            };

        } catch (error) {
            console.error('ExploreQuest.doWork() failed:', error);
            this._jobStatus_ = STATUS_ERROR;
            return { success: false, error: error.message, completed: this._completedThisRun_ };
        }
    }

    /**
     * Returns a summary of current task state for the popup.
     */
    getStatus() {
        return {
            jobStatus: this._jobStatus_,
            tasks: this._tasks_.map(t => ({
                title: t.title,
                description: t.description,
                pointProgressMax: t.pointProgressMax,
                pointProgress: t.pointProgress,
                complete: t.complete,
                isActivated: t.isActivated
            })),
            completedThisRun: this._completedThisRun_,
            errors: this._errors_
        };
    }

    // -------------------------------------------------------------------------
    // Task Fetching
    // -------------------------------------------------------------------------

    /**
     * Fetches incomplete Explore-on-Bing tasks from two sources:
     *   1. Detailed Rewards dashboard (punchCards – the primary source for Explore tasks)
     *   2. Flyout API MorePromotions / DailySetPromotions (fallback)
     *
     * Handles both plain-JSON and HTML-with-embedded-JSON responses gracefully.
     */
    async _fetchExploreTasks() {
        try {
            console.log('ExploreQuest: Fetching promotions from Bing flyout...');

            // ── Fetch the flyout page ──────────────────────────────────────────
            // The flyout returns HTML containing a JS call like:
            //   RewardsApp.initFlyoutApp({"FlyoutConfig":...,"FlyoutResult":{...}});;
            // We extract the JSON argument using the same regex as the upstream
            // DailyRewardStatus.getUserStatusJSON().
            const response = await fetch('https://www.bing.com/rewardsapp/flyout?channel=0', {
                method: 'GET',
                credentials: 'include'
            });

            if (!response.ok) {
                console.error(`ExploreQuest: Flyout returned HTTP ${response.status}`);
                return [];
            }

            const text = await response.text();

            // Extract embedded JSON – same pattern as upstream getUserStatusJSON()
            const match = /(=?\{"FlyoutConfig":).*(=?\}\);;)/.exec(text);
            if (!match) {
                console.warn('ExploreQuest: Could not locate FlyoutConfig JSON in flyout response. ' +
                    `Response starts with: ${text.slice(0, 200)}`);
                return [];
            }

            // Strip the trailing ");;", leaving a valid JSON object
            const rawJson = match[0].slice(0, match[0].length - 3);
            let flyoutData;
            try {
                flyoutData = JSON.parse(rawJson);
            } catch (e) {
                console.error('ExploreQuest: Failed to parse flyout JSON:', e.message);
                return [];
            }

            const flyoutResult = flyoutData?.FlyoutResult;
            if (!flyoutResult) {
                console.warn('ExploreQuest: FlyoutResult missing from parsed JSON');
                return [];
            }

            const morePr  = flyoutResult.MorePromotions || [];
            // DailySetPromotions is { "MM/DD/YYYY": [...] }, not an array
            const dailyPrRaw = flyoutResult.DailySetPromotions || {};
            const dailyPr = Array.isArray(dailyPrRaw)
                ? dailyPrRaw
                : Object.values(dailyPrRaw).flat();
            const allRaw  = [...morePr, ...dailyPr];

            console.log(`ExploreQuest: Flyout → MorePromotions=${morePr.length}, DailySetPromotions=${dailyPr.length}`);

            // ── Filter to eligible (incomplete) tasks ─────────────────────────
            const eligibleTasks = this._filterEligibleTasks(allRaw);
            console.log(`ExploreQuest: ${eligibleTasks.length} eligible task(s) after filter`);

            // ── Weekly deduplication via storage ──────────────────────────────
            const storedData = await chrome.storage.local.get({ completedExploreTasks: {} });
            const completedTasks = storedData.completedExploreTasks || {};

            // Purge records older than 7 days
            const cleanedCompleted = {};
            for (const [key, dateStr] of Object.entries(completedTasks)) {
                const daysDiff = (Date.now() - new Date(dateStr).getTime()) / 86400000;
                if (daysDiff < 7) cleanedCompleted[key] = dateStr;
            }
            await chrome.storage.local.set({ completedExploreTasks: cleanedCompleted });

            const pendingTasks = eligibleTasks.filter(
                task => !cleanedCompleted[this._getTaskKey(task)]
            );

            console.log(`ExploreQuest: ${pendingTasks.length} pending task(s) after weekly dedup`);
            return pendingTasks;

        } catch (error) {
            console.error('ExploreQuest: _fetchExploreTasks failed:', error);
            return [];
        }
    }

    /**
     * Filters promotions to those that are:
     * - Not yet fully completed (pointProgress < pointProgressMax)
     * - Search-type activities (have a Bing search URL or known search type)
     */
    _filterEligibleTasks(promotions) {
        return promotions.filter(promo => {
            // Must be an object
            if (!promo || typeof promo !== 'object') return false;

            // Fields are PascalCase in the flyout API response
            const complete = promo.Complete ?? (promo.Attributes?.complete === 'True') ?? promo.complete;
            const pointProgressMax = promo.PointProgressMax ?? promo.pointProgressMax ?? 0;
            const pointProgress = promo.PointProgress ?? promo.pointProgress ?? 0;
            const title = promo.Title || promo.Name || promo.title || promo.name;

            // Skip already fully completed tasks
            if (complete === true) return false;
            if (pointProgress >= pointProgressMax && pointProgressMax > 0) return false;

            // Skip if it genuinely has no point value
            if (pointProgressMax === 0 && pointProgress === 0) return false;

            // Must have a title
            return !!title;
        }).map(promo => ({
            title: promo.Title || promo.Name || promo.title || promo.name || 'Unknown Task',
            description: promo.Description || promo.description || '',
            promotionType: promo.PromotionType || promo.promotionType || '',
            pointProgressMax: promo.PointProgressMax ?? promo.pointProgressMax ?? 0,
            pointProgress: promo.PointProgress ?? promo.pointProgress ?? 0,
            complete: promo.Complete ?? promo.complete ?? false,
            destinationUrl: promo.DestinationUrl || promo.destinationUrl || promo.Attributes?.destination || '',
            attributes: promo.Attributes || promo.attributes || {},
            isActivated: ((promo.PointProgress ?? promo.pointProgress ?? 0) > 0 && !(promo.Complete ?? promo.complete)) ||
                         ((promo.Attributes || promo.attributes || {})?.promotionType === 'activated')
        }));
    }

    // -------------------------------------------------------------------------
    // Task Processing
    // -------------------------------------------------------------------------

    /**
     * Processes a single explore task:
     * 1. Activates the task (visits its destination URL)
     * 2. Performs a Bing search with a relevant keyword
     * 3. Marks it as completed in storage
     */
    async _processTask(task) {
        console.log(`ExploreQuest: Processing task "${task.title}"`);

        // Human-like pause before clicking — a real user doesn't instantly click
        await this._randomDelay(1000, 4000);

        // Step 1: Activate the task by visiting its destination/activation URL
        const activated = await this._activateTask(task);
        if (!activated) {
            console.warn(`ExploreQuest: Could not activate task "${task.title}", attempting search anyway`);
        }

        // Pause after activation — simulate the user reading the activated page
        // before navigating away to search (4–10 seconds, variable)
        await this._randomDelay(4000, 10000);

        // Step 2: Perform the search
        const searchTerm = this._extractSearchTerm(task);
        if (!searchTerm) {
            console.warn(`ExploreQuest: No search term found for task "${task.title}", skipping`);
            return false;
        }

        console.log(`ExploreQuest: Performing search for "${task.title}" with term: "${searchTerm}"`);
        const searched = await this._performSearch(searchTerm, task);

        if (searched) {
            // Mark as completed in storage
            await this._markTaskCompleted(task);
            return true;
        }

        return false;
    }

    /**
     * Activates a task by visiting its destination URL via a background fetch
     * (which registers the activity with Microsoft Rewards).
     */
    async _activateTask(task) {
        if (!task.destinationUrl) {
            console.log(`ExploreQuest: No destination URL for "${task.title}", skipping activation`);
            return false;
        }

        // rewards.bing.com URLs redirect to OAuth from extension context (CORS blocked).
        // Open them in a background tab instead so the browser handles auth naturally.
        let url;
        try {
            url = new URL(task.destinationUrl);
        } catch (e) {
            console.warn(`ExploreQuest: Invalid destination URL for "${task.title}": ${task.destinationUrl}`);
            return false;
        }

        if (url.hostname === 'rewards.bing.com' || url.hostname.endsWith('.rewards.bing.com')) {
            console.log(`ExploreQuest: Opening rewards.bing.com activation URL in background tab for "${task.title}"`);
            try {
                const tab = await chrome.tabs.create({ url: task.destinationUrl, active: false });
                // Wait for the page to fully load and register the activity.
                // Use a randomised wait (3–7 s) to avoid a fixed-interval fingerprint.
                await this._randomDelay(3000, 7000);
                await chrome.tabs.remove(tab.id).catch(() => {});
                return true;
            } catch (error) {
                console.error(`ExploreQuest: Failed to open activation tab for "${task.title}":`, error);
                return false;
            }
        }

        try {
            console.log(`ExploreQuest: Activating "${task.title}" via ${task.destinationUrl}`);

            const response = await fetch(task.destinationUrl, {
                method: 'GET',
                credentials: 'include',
                headers: {
                    'User-Agent': userAgents?.pc || navigator.userAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Referer': 'https://www.bing.com/'
                }
            });

            if (response.ok) {
                console.log(`ExploreQuest: Successfully activated "${task.title}" (status: ${response.status})`);
                return true;
            } else {
                console.warn(`ExploreQuest: Activation returned status ${response.status} for "${task.title}"`);
                return false;
            }
        } catch (error) {
            console.error(`ExploreQuest: Error activating task "${task.title}":`, error);
            return false;
        }
    }

    /**
     * Performs a Bing search for the given term using the PC user agent.
     * Uses the same fetch-based approach as SearchQuest to earn points.
     */
    async _performSearch(searchTerm, task) {
        const MAX_RETRIES = 3;
        const encodedTerm = encodeURIComponent(searchTerm);
        const searchUrl = `https://www.bing.com/search?q=${encodedTerm}&form=QBRE&src=EXPLOREQ`;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                console.log(`ExploreQuest: Search attempt ${attempt}/${MAX_RETRIES}: "${searchTerm}"`);

                // Simulate the user typing and pressing Enter — short variable delay
                await this._randomDelay(800, 2500);

                const response = await fetch(searchUrl, {
                    method: 'GET',
                    credentials: 'include',
                    headers: {
                        'User-Agent': userAgents?.pc || navigator.userAgent,
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'Referer': 'https://www.bing.com/'
                    }
                });

                if (response.status === 200) {
                    console.log(`ExploreQuest: Search successful for "${searchTerm}"`);
                    return true;
                } else {
                    console.warn(`ExploreQuest: Search returned status ${response.status} (attempt ${attempt})`);
                }

            } catch (error) {
                console.error(`ExploreQuest: Search error (attempt ${attempt}):`, error);
            }

            if (attempt < MAX_RETRIES) {
                // Exponential back-off with jitter to prevent thundering-herd
                // detection (base 5 s per attempt + up to 5 s of random jitter)
                const backoff = 5000 * attempt + Math.floor(Math.random() * 5000);
                console.log(`ExploreQuest: Retrying in ${Math.round(backoff / 1000)}s...`);
                await this._sleep(backoff);
            }
        }

        return false;
    }

    // -------------------------------------------------------------------------
    // Search Term Extraction
    // -------------------------------------------------------------------------

    /**
     * Extracts the best search term for a task.
     * Priority: destinationUrl q= param → attributes keyword → description keywords → title keywords
     */
    _extractSearchTerm(task) {
        // 1. Try to extract from destination URL q= parameter
        if (task.destinationUrl) {
            try {
                const url = new URL(task.destinationUrl);
                const q = url.searchParams.get('q');
                if (q && q.trim()) {
                    console.log(`ExploreQuest: Extracted search term from URL: "${q}"`);
                    return q.trim();
                }
            } catch (e) {
                // URL parsing failed, continue to next strategy
            }
        }

        // 2. Try attributes for explicit keyword
        const attrs = task.attributes || {};
        if (attrs.keyword) return attrs.keyword;
        if (attrs.searchTerm) return attrs.searchTerm;
        if (attrs.query) return attrs.query;

        // 3. Generate a smart search term from title/description
        const derived = this._deriveSearchTermFromTask(task);
        if (derived) {
            console.log(`ExploreQuest: Derived search term: "${derived}"`);
            return derived;
        }

        return null;
    }

    /**
     * Derives a meaningful search term from a task's title and description
     * using keyword mapping and NLP-like extraction.
     */
    _deriveSearchTermFromTask(task) {
        const title = (task.title || '').toLowerCase();
        const description = (task.description || '').toLowerCase();
        const combined = `${title} ${description}`;

        // Keyword mapping for common "Explore on Bing" task themes
        const themeMap = [
            { keywords: ['flight', 'travel', 'trip', 'vacation', 'affordable flight', 'book flight', 'take off'],
              searchTerm: 'affordable flights booking' },
            { keywords: ['deal', 'shopping', 'shop', 'buy', 'shopping list', 'find deal'],
              searchTerm: 'best shopping deals online' },
            { keywords: ['book', 'read', 'novel', 'next read', 'review'],
              searchTerm: 'best books to read 2024' },
            { keywords: ['diy', 'craft', 'creative', 'art', 'kit', 'craft supply'],
              searchTerm: 'DIY craft kits ideas' },
            { keywords: ['stream', 'streaming', 'watch', 'movies', 'tv show', 'platform', 'bundle'],
              searchTerm: 'best streaming platforms 2024' },
            { keywords: ['phone', 'cell', 'mobile', 'plan', 'carrier', 'text', 'talk', 'save'],
              searchTerm: 'best cell phone plans' },
            { keywords: ['restaurant', 'food', 'eat', 'dining', 'dinner', 'lunch'],
              searchTerm: 'best restaurants near me' },
            { keywords: ['hotel', 'stay', 'accommodation', 'lodging'],
              searchTerm: 'best hotel deals booking' },
            { keywords: ['car', 'auto', 'vehicle', 'lease', 'buy car'],
              searchTerm: 'best car deals lease offers' },
            { keywords: ['insurance', 'coverage', 'policy', 'home insurance', 'car insurance'],
              searchTerm: 'best insurance coverage options' },
            { keywords: ['fitness', 'gym', 'workout', 'exercise', 'health', 'wellness'],
              searchTerm: 'fitness workout plans gym membership' },
            { keywords: ['recipe', 'cook', 'kitchen', 'meal', 'ingredient'],
              searchTerm: 'easy healthy recipes to cook' },
            { keywords: ['game', 'gaming', 'play', 'video game', 'console'],
              searchTerm: 'best video games 2024' },
            { keywords: ['news', 'current event', 'today'],
              searchTerm: 'latest news today' },
            { keywords: ['pet', 'dog', 'cat', 'animal'],
              searchTerm: 'best pet supplies dog cat' },
            { keywords: ['home', 'decor', 'interior', 'furniture', 'remodel'],
              searchTerm: 'home decor interior design ideas' },
            { keywords: ['tech', 'technology', 'gadget', 'device', 'laptop', 'tablet'],
              searchTerm: 'best tech gadgets 2024' },
            { keywords: ['sport', 'team', 'score', 'athlete', 'game ticket'],
              searchTerm: 'sports scores highlights 2024' },
            { keywords: ['finance', 'invest', 'stock', 'money', 'saving'],
              searchTerm: 'personal finance investment tips' },
            { keywords: ['education', 'learn', 'course', 'school', 'study'],
              searchTerm: 'online learning courses education' },
        ];

        for (const mapping of themeMap) {
            if (mapping.keywords.some(kw => combined.includes(kw))) {
                return mapping.searchTerm;
            }
        }

        // Fallback: extract meaningful words from description
        const stopWords = new Set(['search', 'bing', 'find', 'the', 'a', 'an', 'on', 'to', 'for',
                                    'your', 'and', 'or', 'in', 'with', 'of', 'that', 'is', 'are',
                                    'it', 'this', 'you', 'how', 'what', 'use', 'get', 'best', 'next']);
        const words = description.split(/\s+/)
            .map(w => w.replace(/[^a-z0-9]/gi, ''))
            .filter(w => w.length > 3 && !stopWords.has(w.toLowerCase()));

        if (words.length >= 2) {
            return words.slice(0, 4).join(' ');
        }

        // Last resort: use the task title
        return task.title || null;
    }

    // -------------------------------------------------------------------------
    // Storage / State
    // -------------------------------------------------------------------------

    _getTaskKey(task) {
        // Unique key based on title + destination URL to identify this specific task  
        return `${(task.title || '').toLowerCase().replace(/\s+/g, '_')}_${task.destinationUrl || ''}`;
    }

    async _markTaskCompleted(task) {
        try {
            const storedData = await chrome.storage.local.get({ completedExploreTasks: {} });
            const completedTasks = storedData.completedExploreTasks || {};
            completedTasks[this._getTaskKey(task)] = new Date().toISOString();
            await chrome.storage.local.set({ completedExploreTasks: completedTasks });
            console.log(`ExploreQuest: Marked task "${task.title}" as completed`);
        } catch (error) {
            console.error('ExploreQuest: Failed to mark task as completed:', error);
        }
    }

    // -------------------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------------------

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Waits for a random duration between minMs and maxMs milliseconds.
     * Used throughout to mimic natural human timing variability and avoid
     * pattern-based automation detection.
     */
    _randomDelay(minMs, maxMs) {
        const ms = Math.floor(minMs + Math.random() * (maxMs - minMs));
        return this._sleep(ms);
    }
}
