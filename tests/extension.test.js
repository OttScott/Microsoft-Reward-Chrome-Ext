const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const sourceRoot = path.join(__dirname, '..', 'src');
const extensionVersion = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'manifest.json'), 'utf8')).version;
const now = new Date(2026, 9, 20, 12).getTime();

class TestDate extends Date {
    constructor(...args) {
        super(...(args.length ? args : [now]));
    }

    static now() {
        return now;
    }
}

function createEvent() {
    const listeners = new Set();
    return {
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener),
        emit: (...args) => Promise.all([...listeners].map((listener) => listener(...args))),
        listeners,
    };
}

function rewardsPayload(pc = 0, mobile = 0) {
    return {
        IsError: false,
        IsRewardsUser: true,
        FlyoutResult: {
            UserStatus: {
                AvailablePoints: 1234,
                Counters: {
                    PCSearch: [{PointProgress: pc, PointProgressMax: 150}],
                    MobileSearch: [{PointProgress: mobile, PointProgressMax: 100}],
                    ActivityAndQuiz: [{PointProgress: 0, PointProgressMax: 10}],
                },
            },
            DailySetPromotions: {},
            MorePromotions: [],
        },
    };
}

async function createHarness(sync = {}, local = {}) {
    const alarms = new Map();
    const timers = new Map();
    const messages = [];
    const scriptTargets = [];
    const removedTabs = [];
    const requests = [];
    const requestOptions = [];
    const ruleUpdates = [];
    let nextTimer = 0;
    let payload = rewardsPayload();

    function storageArea(data) {
        return {
            get(keys, callback) {
                const defaults = typeof keys === 'string' ? {[keys]: undefined} :
                    Array.isArray(keys) ? Object.fromEntries(keys.map((key) => [key, undefined])) :
                        keys || data;
                const result = {...defaults};
                for (const key of Object.keys(defaults)) {
                    if (Object.hasOwn(data, key)) result[key] = data[key];
                }
                if (callback) callback(result);
                return Promise.resolve(result);
            },
            set(values, callback) {
                Object.assign(data, values);
                if (callback) callback();
                return Promise.resolve();
            },
            remove(keys, callback) {
                for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
                if (callback) callback();
                return Promise.resolve();
            },
        };
    }

    const tabUpdates = createEvent();
    const chrome = {
        storage: {local: storageArea(local), sync: storageArea(sync)},
        runtime: {
            onMessage: createEvent(),
            onInstalled: createEvent(),
            onStartup: createEvent(),
            onSuspend: createEvent(),
            getURL: (file) => `chrome-extension://test/${file}`,
            getManifest: () => ({version: extensionVersion}),
            sendMessage(message, callback) {
                messages.push(message);
                if (callback) callback({success: true});
                return Promise.resolve({success: true});
            },
        },
        alarms: {
            onAlarm: createEvent(),
            async create(name, options) {
                alarms.set(name, {name, ...options, scheduledTime: options.when});
            },
            async get(name) {
                return alarms.get(name);
            },
            async getAll() {
                return [...alarms.values()];
            },
            async clear(name) {
                return alarms.delete(name);
            },
        },
        notifications: {create: async () => 'notification'},
        tabs: {
            onUpdated: tabUpdates,
            async create({url}) {
                setImmediate(() => tabUpdates.emit(41, {status: 'complete'}));
                return {id: 41, url, status: 'loading'};
            },
            async get(id) {
                assert.equal(typeof id, 'number');
                return {id, status: 'complete'};
            },
            async update(id, options) {
                assert.equal(typeof id, 'number');
                return {id, ...options};
            },
            async remove(id) {
                assert.equal(typeof id, 'number');
                removedTabs.push(id);
            },
        },
        scripting: {
            async executeScript(options) {
                scriptTargets.push(options.target.tabId);
                assert.equal(typeof options.target.tabId, 'number');
                return [{result: []}];
            },
        },
        declarativeNetRequest: {
            async updateDynamicRules(update) {
                ruleUpdates.push(update);
            },
        },
    };
    const context = vm.createContext({
        chrome,
        Date: TestDate,
        AbortController,
        URL,
        navigator: {onLine: true},
        self: {addEventListener() {}},
        console: Object.fromEntries(['log', 'warn', 'error', 'debug', 'assert'].map((key) => [key, () => {}])),
        setTimeout(fn, ms) {
            const id = ++nextTimer;
            timers.set(id, {fn, ms});
            return id;
        },
        clearTimeout: (id) => timers.delete(id),
        setInterval(fn, ms) {
            const id = ++nextTimer;
            timers.set(id, {fn, ms});
            return id;
        },
        clearInterval: (id) => timers.delete(id),
        async fetch(url, options) {
            requests.push(url);
            requestOptions.push(options);
            const text = JSON.stringify(payload);
            return {ok: true, status: 200, text: async () => text, json: async () => payload};
        },
        STATUS_NONE: 0,
        STATUS_BUSY: 1,
        STATUS_DONE: 20,
        STATUS_WARNING: 30,
        STATUS_ERROR: 3,
        SEARCH_TYPE_PC_SEARCH: 0,
        SEARCH_TYPE_MB_SEARCH: 1,
        GoogleTrend: class {
            reset() {}
            async getGoogleTrendWords() {}
            async getNextTermForDisplayAsync() {
                return 'next term';
            }
        },
        ExploreQuest: class {
            reset() {}
            async doWork() {
                return {success: true, completed: 0, total: 0};
            }
        },
        GreyBadge: class {},
        BusyBadge: class {},
        DoneBadge: class {},
        ErrorBadge: class {},
        WarningBadge: class {},
        setBadge() {},
        isCurrentBadge: () => false,
    });
    const run = (code) => vm.runInContext(code, context);
    for (const file of ['exception.js', 'utility.js', 'status\\DailyRewardStatus.js',
        'quest\\searchQuest.js', 'quest\\dailyTasksQuest.js', 'background.js']) {
        run(fs.readFileSync(path.join(sourceRoot, file), 'utf8'));
    }
    await new Promise((resolve) => setImmediate(resolve));
    return {
        run, context, chrome, sync, local, alarms, timers, messages,
        scriptTargets, removedTabs, requests, requestOptions, ruleUpdates,
        setPayload(value) {
            payload = value;
        },
        message(message) {
            return new Promise((resolve) => {
                [...chrome.runtime.onMessage.listeners][0](message, {}, resolve);
            });
        },
    };
}

test('manual restart uses the SearchQuest API instead of assigning a getter', async () => {
    const h = await createHarness();
    h.run(`searchQuest._jobStatus_ = STATUS_DONE;
        searchQuest._manuallyPaused = true;
        globalThis.started = false;
        doBackgroundWork = async () => { started = true; };`);
    const response = await h.message({action: 'startSearches'});
    assert.equal(response.success, true);
    assert.equal(h.run('started'), true);
    assert.equal(h.run('searchQuest._manuallyPaused'), false);
});

test('manual work bypasses schedule and status cooldown', async () => {
    const h = await createHarness(
        {enableSchedule: true, startTime: '09:00', endTime: '10:00'},
        {lastStatusCheck: now - 1000},
    );
    h.run(`isSchedulePaused = true;
        globalThis.statusChecks = 0;
        checkDailyRewardStatus = async (force) => { if (force) statusChecks++; };
        waitTillOnline = async () => {};
        checkDayChange = async () => {};`);
    await h.run(`doBackgroundWork('manualStart')`);
    assert.equal(h.run('statusChecks'), 1);
});

test('manual start acknowledges the request without waiting for a search session', async () => {
    const h = await createHarness();
    h.run('doBackgroundWork = () => new Promise(() => {});');
    const response = await Promise.race([
        h.message({action: 'startSearches'}),
        new Promise((resolve) => setImmediate(() => resolve(null))),
    ]);
    assert.equal(response?.success, true);
});

test('PC completion does not block mobile in the smart strategy', async () => {
    const h = await createHarness();
    h.run(`searchQuest._status_ = {
        summary: {searchPointsEarned: 0, maxDailySearchPoints: 250},
        pcSearchStatus: {progress: 0, progressMax: 1, isCompleted: false},
        mbSearchStatus: {progress: 0, progressMax: 1, isCompleted: false},
        update: async () => true
    };
    searchQuest._jobStatus_ = STATUS_BUSY;
    searchQuest._currentSearchType_ = SEARCH_TYPE_PC_SEARCH;
    searchQuest._currentSearchCount_ = 0;
    searchQuest._getCurrentMaxSearches = () => 1;
    searchQuest._isCurrentSearchCompleted = () => searchQuest._currentSearchCount_ >= 1;
    searchQuest._performSingleSearch = async () => {
        searchQuest._currentSearchCount_++;
        searchQuest._status_.pcSearchStatus.isCompleted = true;
        return {success: true};
    };
    searchQuest._doPcSearch = () => searchQuest._requestBingSearch();
    globalThis.mobileCalls = 0;
    searchQuest._doMbSearch = async () => {
        mobileCalls++;
        searchQuest._status_.mbSearchStatus.isCompleted = true;
    };
    removeUA = () => {};`);
    await h.run('searchQuest._doSmartSearches({disableMobile: false})');
    assert.equal(h.run('mobileCalls'), 1);
});

test('Rewards status reads real counters and preserves zero remaining points', async () => {
    const h = await createHarness();
    const payload = rewardsPayload(150, 100);
    payload.FlyoutResult.UserStatus.Counters.ActivityAndQuiz[0].PointProgress = 10;
    h.setPayload(payload);
    await h.run('userDailyStatus.update()');
    assert.equal(h.run('userDailyStatus.summary.availablePoints'), 0);
    assert.equal(h.run('userDailyStatus.summary.searchPointsEarned'), 250);
    assert.equal(h.run('userDailyStatus.summary.maxDailySearchPoints'), 250);
    assert.equal(h.run('userDailyStatus.pcSearchStatus.isValid'), true);
    assert.equal(h.run('userDailyStatus.pcSearchStatus.progress'), 30);
    assert.equal(h.run('userDailyStatus.isSearchCompleted'), true);
    assert(h.requests.some((url) => url.includes('/rewardsapp/flyout')));
});

test('Rewards status rejects a login page instead of inventing progress', async () => {
    const h = await createHarness();
    h.context.fetch = async () => ({ok: true, text: async () => '<html>Please sign in</html>'});
    await assert.rejects(h.run('userDailyStatus.update()'));
    assert.equal(h.run('userDailyStatus.jobStatus'), 3);
    assert.equal(h.run('userDailyStatus.summary.isValid'), false);
});

test('missing mobile counter is explicitly unavailable, not pending work', async () => {
    const h = await createHarness();
    const payload = rewardsPayload();
    delete payload.FlyoutResult.UserStatus.Counters.MobileSearch;
    h.setPayload(payload);
    await h.run('userDailyStatus.update()');
    assert.equal(h.run('userDailyStatus.mbSearchStatus.isValid'), false);
});

test('regular work and schedule transitions create durable alarms', async () => {
    const h = await createHarness();
    await h.run('scheduleNextWork()');
    await h.run(`scheduleNextStateChange({enableSchedule: true, startTime: '09:00', endTime: '17:00'})`);
    assert(h.alarms.has('regularWork'));
    assert(h.alarms.has('scheduleTransition'));
    assert.equal(h.alarms.get('scheduleTransition').when, new TestDate(2026, 9, 20, 17).getTime());
});

test('overnight schedule transitions target the following morning', async () => {
    const h = await createHarness();
    await h.run(`scheduleNextStateChange({enableSchedule: true, startTime: '09:00', endTime: '06:00'})`);
    assert.equal(h.alarms.get('scheduleTransition')?.when, new TestDate(2026, 9, 21, 6).getTime());
});

test('legacy same-day date formats neither restart mornings nor reset counters', async () => {
    for (const date of [new TestDate().toLocaleDateString(), new TestDate().toDateString()]) {
        const h = await createHarness({}, {lastRunDate: date, pcSearchCount: 12});
        h.run('globalThis.restarts = 0; handleMorningRestart = async () => { restarts++; };');
        await h.run('checkNewDay()');
        await h.run('checkForMissedMorningStart()');
        assert.equal(h.local.pcSearchCount, 12);
        assert.equal(h.run('restarts'), 0);
        assert.equal(h.local.lastRunDate, '2026-10-20');
    }
});

test('saving options tells the background to rebuild the schedule', async () => {
    const h = await createHarness();
    const elements = new Map();
    h.context.document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, {checked: true, value: '5', addEventListener() {}});
            return elements.get(id);
        },
        addEventListener() {},
    };
    h.run(fs.readFileSync(path.join(sourceRoot, 'popup', 'options.js'), 'utf8'));
    h.run('saveOptions()');
    const message = h.messages.find((entry) => entry.action === 'updateSearchSettings');
    assert.equal(message.content.scheduleChanged, true);
    h.run('globalThis.scheduleUpdates = 0; initializeScheduleSystem = async () => { scheduleUpdates++; };');
    await h.message(message);
    assert.equal(h.run('scheduleUpdates'), 1);
});

test('Daily Tasks opens and closes a numeric tab ID', async () => {
    const h = await createHarness();
    const tabId = await h.run(`dailyTasksQuest._openTab('https://rewards.bing.com/')`);
    assert.equal(tabId, 41);
    h.run('dailyTasksQuest._activeTabId = 41');
    await h.run('dailyTasksQuest._closeActiveTab()');
    assert.deepEqual(h.removedTabs, [41]);
});

test('Daily Tasks propagates script injection errors', async () => {
    const h = await createHarness();
    h.chrome.scripting.executeScript = async () => {
        throw new Error('Missing host permission');
    };
    await assert.rejects(h.run('dailyTasksQuest._execInTab(41, () => true)'), /host permission/);
});

test('Daily Tasks failures remain retryable instead of marking today done', async () => {
    const h = await createHarness({enableDailyTasks: true, dailyTaskDelay: 0});
    h.run(`dailyTasksQuest._openTab = async () => 41;
        dailyTasksQuest._waitMs = async () => {};
        dailyTasksQuest._getActivities = async () => [{id: 'task', title: 'Test', url: 'https://www.bing.com/quiz'}];
        dailyTasksQuest._completeActivity = async () => { throw new Error('Quiz failed'); };`);
    await h.run('dailyTasksQuest.doWork()');
    assert.notEqual(h.local.dailyTasksDone, true);
    assert.equal(h.run('dailyTasksQuest.jobStatus'), 3);
});

test('Daily Tasks delays use a Chrome alarm rather than a long timeout', async () => {
    const h = await createHarness({enableDailyTasks: true, dailyTaskDelay: 5});
    await h.run('checkQuizAndDaily()');
    assert(h.alarms.has('dailyTasks'));
});

test('disabled Daily Tasks does not enqueue a daily task alarm', async () => {
    const h = await createHarness({enableDailyTasks: false});
    await h.run('checkQuizAndDaily()');
    assert.equal(h.alarms.has('dailyTasks'), false);
});

test('simultaneous work requests share a single execution', async () => {
    const h = await createHarness();
    h.run('globalThis.executions = 0; runBackgroundWork = async () => { executions++; };');
    await h.run(`Promise.all([doBackgroundWork('manualStart'), doBackgroundWork('scheduled')])`);
    assert.equal(h.run('executions'), 1);
});

test('popup progress distinguishes startup from idle', async () => {
    const h = await createHarness();
    h.run('backgroundWorkPromise = new Promise(() => {});');
    const response = await h.message({action: 'getSearchProgress'});
    assert.equal(response.starting, true);
    assert.equal(response.inProgress, false);
});

test('background failures are persisted and exposed to the popup', async () => {
    const h = await createHarness();
    h.run(`runBackgroundWork = async () => { throw new Error('Rewards requires sign-in'); };`);
    await assert.rejects(h.run(`doBackgroundWork('manualStart')`), /sign-in/);
    const response = await h.message({action: 'getSearchProgress'});
    assert.match(response.error, /sign-in/);
    assert.equal(h.local.workState, 'error');
});

test('future regular work times survive a worker restart without an alarm', async () => {
    const future = new TestDate(now + 600000).toISOString();
    const h = await createHarness({}, {nextRegularWorkTime: future});
    await h.run('scheduleNextWork()');
    assert.equal(h.alarms.get('regularWork').when, now + 600000);
    assert.equal(h.local.nextRegularWorkTime, future);
});

test('regular work rearms recovery before starting a potentially long search session', async () => {
    const h = await createHarness();
    h.context.hasRecoveryAlarm = () => h.alarms.has('regularWork');
    h.run(`globalThis.recoveryWasArmed = false;
        doBackgroundWork = async () => { recoveryWasArmed = hasRecoveryAlarm(); };`);
    await h.chrome.alarms.onAlarm.emit({name: 'regularWork'});
    assert.equal(h.run('recoveryWasArmed'), true);
});

test('viewing an overdue schedule runs the work instead of postponing it', async () => {
    const h = await createHarness({}, {nextRegularWorkTime: new TestDate(now - 1000).toISOString()});
    h.run('globalThis.starts = 0; doBackgroundWork = async () => { starts++; };');
    await h.message({action: 'getNextScheduledTime'});
    assert.equal(h.run('starts'), 1);
    assert.equal(h.alarms.has('regularWork'), false);
});

test('disabling scheduling clears a persisted schedule pause', async () => {
    const h = await createHarness({enableSchedule: false}, {isSchedulePaused: true, scheduleState: 'paused'});
    h.run(`isSchedulePaused = true; searchQuest._pausedBySchedule = true; searchQuest._jobStatus_ = STATUS_DONE;`);
    await h.run('initializeScheduleSystem()');
    assert.equal(h.run('isSchedulePaused'), false);
    assert.equal(h.local.isSchedulePaused, false);
    assert.equal(h.run('searchQuest._pausedBySchedule'), false);
});

test('a schedule pause resumes, but a manual stop requires a manual restart', async () => {
    const h = await createHarness();
    h.run(`searchQuest._jobStatus_ = STATUS_BUSY; searchQuest._currentSearchType_ = 0;`);
    await h.run(`searchQuest.forceStop('schedule')`);
    assert.equal(h.run('searchQuest._manuallyPaused'), false);
    h.run('searchQuest.resume()');
    assert.equal(h.run('searchQuest.jobStatus'), 0);
    await h.run('searchQuest.forceStop()');
    h.run('searchQuest.resume()');
    assert.equal(h.run('searchQuest._manuallyPaused'), true);
    h.run('searchQuest.resume(true)');
    assert.equal(h.run('searchQuest._manuallyPaused'), false);
});

test('scheduled work respects a manual stop persisted earlier today', async () => {
    const h = await createHarness({}, {
        searchPausedAt: new TestDate().toISOString(),
        searchPausedReason: 'manualStop',
        lastRunDate: '2026-10-20',
    });
    h.run('globalThis.statusChecks = 0; checkDailyRewardStatus = async () => { statusChecks++; };');
    await h.run(`doBackgroundWork('scheduled')`);
    assert.equal(h.run('statusChecks'), 0);
});

test('daily completion schedules the next morning even if non-search activities remain', async () => {
    const h = await createHarness({}, {lastRunDate: '2026-10-20'});
    h.setPayload(rewardsPayload(150, 100));
    h.run('isCurrentBadge = () => true; waitTillOnline = async () => {};');
    await h.run(`doBackgroundWork('manualStart')`);
    assert(h.alarms.has('morningRestart'));
    assert.equal(h.run('userDailyStatus.summary.availablePoints'), 10);
    assert.equal(h.local.pcSearchCount, undefined);
});

test('disabling mobile does not prevent a completed PC day from scheduling tomorrow', async () => {
    const h = await createHarness({disableMobile: true}, {lastRunDate: '2026-10-20'});
    h.setPayload(rewardsPayload(150, 0));
    h.run('isCurrentBadge = () => true; waitTillOnline = async () => {};');
    await h.run(`doBackgroundWork('manualStart')`);
    assert(h.alarms.has('morningRestart'));
});

test('HTTP search success does not fabricate earned Rewards points', async () => {
    const h = await createHarness({}, {dailyPointsEarned: 0});
    h.run('searchQuest._currentSearchType_ = 0; searchQuest._currentSearchCount_ = 1;');
    await h.run('searchQuest._saveSearchProgress()');
    await h.run('userDailyStatus.update()');
    assert.equal(h.local.pcSearchCount, 1);
    assert.equal(h.local.dailyPointsEarned, 0);
    assert.equal(h.run('userDailyStatus.pcSearchStatus.progress'), 0);
    assert.equal(h.run('userDailyStatus.summary.searchPointsEarned'), 0);
});

test('a full default search strategy is bounded when Rewards awards no points', async () => {
    const h = await createHarness({baseSearchCount: 1, searchVariation: 0});
    await h.run('userDailyStatus.update()');
    h.run(`getUA = async () => {};
        removeUA = () => {};
        setPCReqHeaders = () => {};
        setMobileReqHeaders = () => {};
        searchQuest._waitBetweenSearches = async () => {};
        searchQuest._performSingleSearch = async () => {
            searchQuest._currentSearchCount_++;
            return {success: true};
        };`);
    await h.run('searchQuest.doWork(userDailyStatus)');
    assert.equal(h.run('searchQuest.jobStatus'), 20);
    assert.equal(h.run('userDailyStatus.isSearchCompleted'), false);
});

test('accumulated local search attempts do not falsely complete a new server-pending session', async () => {
    const h = await createHarness();
    await h.run('userDailyStatus.update()');
    h.run(`searchQuest._status_ = userDailyStatus;
        searchQuest._currentSearchType_ = 0;
        searchQuest._currentSearchCount_ = 120;
        searchQuest._targetSearchCount = 121;`);
    assert.equal(h.run('searchQuest._getCurrentMaxSearches()'), 121);
    assert.equal(h.run('searchQuest._isCurrentSearchCompleted()'), false);
});

test('embedded multiline flyout JSON is parsed without script suffix assumptions', async () => {
    const h = await createHarness();
    const payload = {FlyoutConfig: {text: 'a brace } and a quote "'}, ...rewardsPayload(25, 10)};
    h.context.flyoutText = `<script>RewardsApp.initFlyoutApp(${JSON.stringify(payload, null, 2)});</script>`;
    const data = h.run('DailyRewardStatus.getUserStatusJSON(flyoutText)');
    assert.equal(data.FlyoutResult.UserStatus.Counters.PCSearch[0].PointProgress, 25);
});

test('Daily Tasks discovers only today, skips completed and paid promotions, and deduplicates URLs', async () => {
    const h = await createHarness();
    const payload = rewardsPayload();
    const quiz = {
        Name: 'quiz', Title: 'Daily quiz', PromotionType: 'quiz',
        PointProgress: 0, PointProgressMax: 10, DestinationUrl: 'https://www.bing.com/search?q=quiz',
    };
    payload.FlyoutResult.DailySetPromotions = {
        '10/20/2026': [quiz, {...quiz, Name: 'completed', Complete: true}],
        '10/21/2026': [{...quiz, DestinationUrl: 'https://www.bing.com/tomorrow'}],
    };
    payload.FlyoutResult.MorePromotions = [
        quiz,
        {...quiz, PromotionType: 'purchase', DestinationUrl: 'https://www.microsoft.com/store'},
    ];
    h.setPayload(payload);
    const activities = await h.run('dailyTasksQuest._getActivities(41)');
    assert.equal(activities.length, 1);
    assert.equal(activities[0].id, 'quiz');
});

test('Daily Tasks marks completion only after Rewards confirms an activity is no longer pending', async () => {
    const h = await createHarness({enableDailyTasks: true});
    h.run(`globalThis.activityFetches = 0;
        dailyTasksQuest._waitMs = async () => {};
        dailyTasksQuest._getActivities = async () => ++activityFetches === 1 ?
            [{id: 'quiz', title: 'Quiz', url: 'https://www.bing.com/quiz'}] : [];
        dailyTasksQuest._completeActivity = async () => {};`);
    await h.run('dailyTasksQuest.doWork()');
    assert.equal(h.local.dailyTasksDone, true);
    assert.equal(h.local.dailyTasksCompleted, 1);
    assert.equal(h.local.dailyTasksVersion, extensionVersion);
    const fetches = h.run('activityFetches');
    await h.run('dailyTasksQuest.doWork()');
    assert.equal(h.run('activityFetches'), fetches);
});

test('incorrect completion flags from the previous release do not suppress a retry', async () => {
    const h = await createHarness({enableDailyTasks: true}, {
        dailyTasksDate: '2026-10-20', dailyTasksDone: true, dailyTasksVersion: '2.28.0.0',
    });
    h.run(`globalThis.retried = false; dailyTasksQuest._runAllActivities = async () => {
        retried = true; throw new Error('Still pending');
    };`);
    await h.run('dailyTasksQuest.doWork()');
    assert.equal(h.run('retried'), true);
    assert.equal(h.local.dailyTasksDone, false);
});

test('Daily Tasks failure alarms schedule a retry instead of abandoning the day', async () => {
    const h = await createHarness({enableDailyTasks: true});
    h.run(`dailyTasksQuest._runAllActivities = async () => { throw new Error('Quiz still pending'); };`);
    await h.chrome.alarms.onAlarm.emit({name: 'dailyTasks'});
    assert.equal(h.alarms.get('dailyTasks')?.delayInMinutes, 30);
    assert.equal(h.local.dailyTasksDone, false);
});

test('initialization is single-flight', async () => {
    const h = await createHarness();
    h.run('globalThis.initializations = 0; initializeCore = async () => { initializations++; };');
    await h.run('Promise.all([initialize(), initialize()])');
    assert.equal(h.run('initializations'), 1);
});

test('search requests include the signed-in Bing session', async () => {
    const h = await createHarness();
    h.run(`searchQuest._jobStatus_ = STATUS_BUSY;
        searchQuest._currentSearchType_ = SEARCH_TYPE_PC_SEARCH;
        searchQuest._searchIntervalMS = 30000;
        googleTrend.nextPCWord = 'test query';`);
    await h.run(`searchQuest._performSingleSearch('PC')`);
    const index = h.requests.findIndex((url) => url.includes('/search?'));
    assert.notEqual(index, -1);
    assert.equal(h.requestOptions[index].credentials, 'include');
});

test('UA rules cover background fetches and are removed after a search session', async () => {
    const h = await createHarness();
    h.run(`userAgents = {pc: 'PC agent', mb: 'Mobile agent'};`);
    await h.run('setPCReqHeaders()');
    await h.run('setMobileReqHeaders()');
    for (const update of h.ruleUpdates) {
        assert(update.addRules[0].condition.resourceTypes.includes('xmlhttprequest'));
    }
    await h.run('removeUA()');
    assert.equal(h.ruleUpdates.at(-1).addRules, undefined);
    assert(h.ruleUpdates.at(-1).removeRuleIds.includes(1));
});

test('search preparation waits for header rules before starting requests', async () => {
    const h = await createHarness();
    let release;
    h.chrome.declarativeNetRequest.updateDynamicRules = () => new Promise((resolve) => {
        release = resolve;
    });
    h.run(`userAgents = {pc: 'PC agent'}; globalThis.prepared = false;`);
    const preparing = h.run('Promise.resolve(searchQuest._preparePCSearch()).then(() => { prepared = true; })');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.run('prepared'), false);
    release();
    await preparing;
    assert.equal(h.run('prepared'), true);
});

test('interleaved sessions respect per-type attempt limits when no points are awarded', async () => {
    const h = await createHarness({interleaveSearches: true, baseSearchCount: 1, searchVariation: 0});
    await h.run('userDailyStatus.update()');
    h.run(`getUA = async () => {};
        removeUA = () => {};
        setPCReqHeaders = () => {};
        setMobileReqHeaders = () => {};
        globalThis.attempts = {PC: 0, Mobile: 0};
        searchQuest._waitBetweenSearches = async () => {};
        searchQuest._performSingleSearch = async (type) => {
            attempts[type]++;
            searchQuest._currentSearchCount_++;
            await searchQuest._saveSearchProgress();
            return {success: true};
        };`);
    await h.run('searchQuest.doWork(userDailyStatus)');
    assert.equal(h.run('attempts.PC'), 1);
    assert.equal(h.run('attempts.Mobile'), 1);
});

test('stopping during preparation cannot restart the search loop', async () => {
    const h = await createHarness();
    await h.run('userDailyStatus.update()');
    h.run(`searchQuest._status_ = userDailyStatus;
        searchQuest._jobStatus_ = STATUS_BUSY;
        searchQuest._preparePCSearch = () => {};
        searchQuest._initiateSearch = async () => { searchQuest._jobStatus_ = STATUS_DONE; };
        globalThis.attempts = 0;
        searchQuest._performSingleSearch = async () => { attempts++; throw new Error('Unexpected request'); };`);
    await h.run('searchQuest._doPcSearch()');
    assert.equal(h.run('attempts'), 0);
    assert.equal(h.run('searchQuest.jobStatus'), 20);
});

test('Daily Tasks tab load timeouts remove listeners and close the task tab', async () => {
    const h = await createHarness({enableDailyTasks: true});
    h.chrome.tabs.create = async () => ({id: 42, status: 'loading'});
    h.chrome.tabs.get = async () => ({id: 42, status: 'loading'});
    const work = h.run('dailyTasksQuest.doWork()');
    await new Promise((resolve) => setImmediate(resolve));
    const timeout = [...h.timers.values()].find((timer) => timer.ms === 15000);
    assert(timeout);
    timeout.fn();
    const result = await work;
    assert.equal(result.success, false);
    assert.equal(h.chrome.tabs.onUpdated.listeners.size, 0);
    assert.deepEqual(h.removedTabs, [42]);
});

function createPopupHarness(response, runtimeError) {
    class Element {
        constructor() {
            this.children = [];
            this.style = {};
            this.events = {};
            this.attributes = {};
        }
        appendChild(element) {
            this.children.push(element);
        }
        prepend(element) {
            this.children.unshift(element);
        }
        replaceChildren() {
            this.children = [];
        }
        setAttribute(key, value) {
            this.attributes[key] = value;
        }
        addEventListener(event, callback) {
            this.events[event] = callback;
        }
    }
    const body = new Element();
    const context = vm.createContext({
        document: {
            body,
            addEventListener() {},
            getElementById: (id) => body.children.find((element) => element.id === id) || null,
            createElement: () => new Element(),
        },
        window: {},
        console,
        chrome: {
            runtime: {
                onMessage: createEvent(),
                lastError: runtimeError,
                sendMessage: (message, callback) => callback(response),
            },
        },
    });
    vm.runInContext(fs.readFileSync(path.join(sourceRoot, 'popup\\popup.js'), 'utf8'), context);
    return {body, run: (code) => vm.runInContext(code, context)};
}

test('popup renders startup rather than immediately falling back to idle', () => {
    const h = createPopupHarness();
    h.run('updateSearchStatusImmediate({starting: true, inProgress: false})');
    assert.match(h.body.children[0].children[0].textContent, /Starting searches/);
});

test('popup visibly reports backend start failures and provides a retry action', () => {
    const h = createPopupHarness({success: false, error: 'Rewards requires sign-in'});
    h.run('startSearchesNow()');
    const status = h.body.children[0];
    assert.match(status.children[0].textContent, /sign-in/);
    assert.equal(status.children[0].attributes.role, 'alert');
    assert.equal(status.children[1].textContent, 'Retry searches');
    assert.equal(typeof status.children[1].events.click, 'function');
});

test('popup visibly reports message transport failures', () => {
    const h = createPopupHarness(undefined, {message: 'Service worker unavailable'});
    h.run('startSearchesNow()');
    assert.match(h.body.children[0].children[0].textContent, /Service worker unavailable/);
});

test('manual work waits for a popup status refresh instead of silently skipping searches', async () => {
    const h = await createHarness({}, {lastRunDate: '2026-10-20'});
    let release;
    h.context.fetch = () => new Promise((resolve) => {
        release = () => resolve({ok: true, text: async () => JSON.stringify(rewardsPayload())});
    });
    h.run(`waitTillOnline = async () => {};
        globalThis.searchChecks = 0;
        checkDailyRewardStatus = async () => { searchChecks++; };`);
    const refreshing = h.run('userDailyStatus.update()');
    const working = h.run(`doBackgroundWork('manualStart')`);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([refreshing, working]);
    assert.equal(h.run('searchChecks'), 1);
});

test('configured Daily Tasks offset is a minimum delay in addition to jitter', async () => {
    const h = await createHarness({enableDailyTasks: true, dailyTaskDelay: 5});
    h.run('Math.random = () => 0');
    await h.run('checkQuizAndDaily()');
    assert.equal(h.alarms.get('dailyTasks').when, now + 5 * 60000);
});

test('full initialization preserves a future regular-work alarm without starting searches early', async () => {
    const future = new TestDate(now + 600000).toISOString();
    const h = await createHarness({}, {lastRunDate: '2026-10-20', nextRegularWorkTime: future});
    h.run(`getUA = async () => {};
        globalThis.starts = 0;
        doBackgroundWork = async () => { starts++; };`);
    await h.run('initialize()');
    assert.equal(h.run('starts'), 0);
    assert.equal(h.alarms.get('regularWork').when, now + 600000);
    assert(h.alarms.has('midnightReset'));
});

test('static rules never replace the browser user agent with an empty placeholder', () => {
    const rules = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'rules.json'), 'utf8'));
    for (const rule of rules) {
        for (const header of rule.action.requestHeaders || []) {
            if (header.header.toLowerCase() === 'user-agent' && header.operation === 'set') {
                assert(header.value.trim().length > 0);
            }
        }
    }
});

test('invalid Daily Set point fields do not invalidate real search counters', async () => {
    for (const promotion of [
        {Complete: false, PointProgressMax: 10},
        {Complete: false, PointProgress: null, PointProgressMax: 10},
        {Complete: false, PointProgress: 0, PointProgressMax: '10'},
        null,
    ]) {
        const h = await createHarness();
        const payload = rewardsPayload(20, 10);
        payload.FlyoutResult.DailySetPromotions = {'10/20/2026': [promotion]};
        h.setPayload(payload);
        await h.run('userDailyStatus.update()');
        assert.equal(h.run('userDailyStatus.summary.isValid'), true);
        assert.equal(h.run('userDailyStatus.pcSearchStatus.progress'), 4);
        assert.equal(h.run('userDailyStatus.mbSearchStatus.progress'), 2);
        assert.equal(h.run('userDailyStatus.summary.earnedToday'), null);
        assert.equal(h.run('userDailyStatus.summary.availablePoints'), null);
        assert.equal(h.run('userDailyStatus.quizAndDailyStatus.isCompleted'), false);
        assert.match(h.run('userDailyStatus.summary.activityTotalsError'), /DailySetPromotions\[0\]/);
    }
});

test('invalid optional activity counter lists leave totals unknown rather than stopping searches', async () => {
    for (const counters of [{}, [{PointProgressMax: 10}], [{PointProgress: null, PointProgressMax: 10}]]) {
        const h = await createHarness();
        const payload = rewardsPayload(20);
        payload.FlyoutResult.UserStatus.Counters.ActivityAndQuiz = counters;
        h.setPayload(payload);
        await h.run('userDailyStatus.update()');
        assert.equal(h.run('userDailyStatus.summary.isValid'), true);
        assert.equal(h.run('userDailyStatus.summary.availablePoints'), null);
        assert.match(h.run('userDailyStatus.summary.activityTotalsError'), /ActivityAndQuiz/);
    }
});

test('malformed search point counters still fail explicitly', async () => {
    const h = await createHarness();
    const payload = rewardsPayload();
    payload.FlyoutResult.UserStatus.Counters.PCSearch[0].PointProgress = null;
    h.setPayload(payload);
    await assert.rejects(h.run('userDailyStatus.update()'), /PCSearch\[0\]/);
    assert.equal(h.run('userDailyStatus.summary.isValid'), false);
});

test('optional promotion handling does not swallow unrelated programming errors', async () => {
    const h = await createHarness();
    h.run(`getDailySetPromotions = () => { throw new TypeError('Unexpected parser bug'); };`);
    await assert.rejects(h.run('userDailyStatus.update()'), /Unexpected parser bug/);
});

test('valid later activity counters restore totals and clear the warning', async () => {
    const h = await createHarness();
    const payload = rewardsPayload(20);
    payload.FlyoutResult.DailySetPromotions = {'10/20/2026': [{PointProgressMax: 10}]};
    h.setPayload(payload);
    await h.run('userDailyStatus.update()');
    assert.match(h.run('userDailyStatus.summary.activityTotalsError'), /DailySetPromotions/);
    h.setPayload(rewardsPayload(20));
    await h.run('userDailyStatus.update()');
    assert.equal(h.run('userDailyStatus.summary.activityTotalsError'), null);
    assert.equal(h.run('userDailyStatus.summary.earnedToday'), 20);
    assert.equal(h.run('userDailyStatus.summary.availablePoints'), 240);
});

test('manual search work proceeds when ActivityAndQuiz point counters are invalid', async () => {
    const h = await createHarness({}, {lastRunDate: '2026-10-20'});
    const payload = rewardsPayload(20);
    payload.FlyoutResult.UserStatus.Counters.ActivityAndQuiz = [{PointProgressMax: 10}];
    h.setPayload(payload);
    h.run(`waitTillOnline = async () => {};
        userAgents = {pc: 'PC user agent', mb: 'Mobile user agent'};
        globalThis.searchesStarted = 0;
        searchQuest.doWork = async (status) => {
            if (status.summary.isValid) searchesStarted++;
        };`);
    await h.run(`doBackgroundWork('manualStart')`);
    assert.equal(h.run('searchesStarted'), 1);
    assert.equal(h.local.lastWorkError, null);
});

test('rewards messages never return successful zero totals after a failed refresh', async () => {
    const h = await createHarness();
    h.context.fetch = async () => ({ok: true, text: async () => '<html>Please sign in</html>'});
    const response = await h.message({action: 'getRewardsData'});
    assert.equal(response.success, false);
    assert.equal(response.data, undefined);
    assert.match(response.error, /Sign in/);
});

test('rewards messages preserve unknown totals while exposing valid search counts and a warning', async () => {
    const h = await createHarness();
    const payload = rewardsPayload(20, 10);
    payload.FlyoutResult.DailySetPromotions = {'10/20/2026': [{PointProgressMax: 10}]};
    h.setPayload(payload);
    const response = await h.message({action: 'getRewardsData'});
    assert.equal(response.success, true);
    assert.equal(response.data.earnedToday, null);
    assert.equal(response.data.remainingPoints, null);
    assert.equal(response.data.pcSearchProgress, 4);
    assert.equal(response.data.mbSearchProgress, 2);
    assert.match(response.data.warning, /activity totals/);
});

test('counter diagnostics identify fields without including promotion titles or URLs', async () => {
    const h = await createHarness();
    const payload = rewardsPayload();
    payload.FlyoutResult.DailySetPromotions = {'10/20/2026': [{
        Title: 'PRIVATE_TITLE', DestinationUrl: 'https://private.invalid/', PointProgressMax: 10,
    }]};
    h.setPayload(payload);
    await h.run('userDailyStatus.update()');
    const diagnostic = h.run('userDailyStatus.summary.activityTotalsError');
    assert.match(diagnostic, /PointProgress=undefined/);
    assert.match(diagnostic, /PointProgressMax=number/);
    assert.doesNotMatch(diagnostic, /PRIVATE_TITLE|private\.invalid/);
});

test('popup renders unknown totals as unavailable while keeping search counts visible', () => {
    const h = createPopupHarness();
    h.run(`for (const id of ['today-earnings', 'remaining-points', 'search-completed', 'search-total', 'rewards-status-warning']) {
        const element = document.createElement('div');
        element.id = id;
        document.body.appendChild(element);
    }
    flashElement = () => {};
    updateStatsDisplay({success: true, data: {
        earnedToday: null, remainingPoints: null,
        pcSearchProgress: 4, mbSearchProgress: 2,
        pcSearchTotal: 30, mbSearchTotal: 20,
        warning: 'Some daily activity totals are unavailable.'
    }});`);
    assert.equal(h.run(`document.getElementById('today-earnings').textContent`), '--');
    assert.equal(h.run(`document.getElementById('remaining-points').textContent`), '--');
    assert.equal(h.run(`document.getElementById('search-completed').textContent`), 6);
    assert.equal(h.run(`document.getElementById('rewards-status-warning').style.display`), 'block');
    h.run(`updateStatsDisplay({success: true, data: {earnedToday: 0, remainingPoints: 0}})`);
    assert.equal(h.run(`document.getElementById('today-earnings').textContent`), 0);
    assert.equal(h.run(`document.getElementById('rewards-status-warning').style.display`), 'none');
});

test('popup clears stale totals when rewards data fails', () => {
    const h = createPopupHarness({success: false, error: 'Sign in required'});
    h.run(`for (const id of ['today-earnings', 'remaining-points']) {
        const element = document.createElement('div');
        element.id = id;
        element.textContent = '0';
        document.body.appendChild(element);
    }
    globalThis.setTimeout = () => {};
    requestRewardsData();`);
    assert.equal(h.run(`document.getElementById('today-earnings').textContent`), '--');
    assert.equal(h.run(`document.getElementById('remaining-points').textContent`), '--');
});
