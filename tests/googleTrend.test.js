const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const sourceRoot = path.join(__dirname, '..', 'src');
const feedUrl = 'https://trends.google.com/trending/rss?geo=US';
const backupTerms = ['archived alpha', 'archived beta', 'archived gamma'];

function rss(titles = ['live alpha', 'live beta', 'live gamma']) {
    return `<?xml version="1.0"?>
        <rss xmlns:ht="https://trends.google.com/trending/rss" version="2.0">
        <channel><title>Daily Search Trends</title>
        ${titles.map((title) => `<item><title>${title}</title>
            <ht:news_item><ht:news_item_title>Not a search term</ht:news_item_title></ht:news_item>
        </item>`).join('')}
        </channel></rss>`;
}

async function createHarness(options = {}) {
    const storage = {...options.storage};
    const requests = [];
    const warnings = [];
    const timers = new Map();
    let timerId = 0;
    const context = vm.createContext({
        AbortController,
        console: {
            log() {},
            warn: (...args) => warnings.push(args),
            error: (...args) => warnings.push(args),
        },
        setTimeout(fn, ms) {
            const id = ++timerId;
            timers.set(id, {fn, ms});
            return id;
        },
        clearTimeout: (id) => timers.delete(id),
        chrome: {
            runtime: {getURL: (file) => `chrome-extension://test/${file}`},
            storage: {
                local: {
                    async get() {
                        return {...storage};
                    },
                    async set(values) {
                        Object.assign(storage, values);
                    },
                    async remove(keys) {
                        for (const key of keys) delete storage[key];
                    },
                },
            },
        },
        async fetch(url, requestOptions) {
            requests.push({url, options: requestOptions});
            if (url.startsWith('chrome-extension:')) {
                if (options.backupResponse) return options.backupResponse();
                return {ok: true, text: async () => backupTerms.join('\n')};
            }
            if (options.liveResponse) return options.liveResponse(url, requestOptions);
            return {ok: true, status: 200, text: async () => rss()};
        },
    });
    const run = (code) => vm.runInContext(code, context);
    run(fs.readFileSync(path.join(sourceRoot, 'googleTrend.js'), 'utf8'));
    run('globalThis.trends = new GoogleTrend()');
    await new Promise((resolve) => setImmediate(resolve));
    return {run, context, storage, requests, warnings, timers};
}

test('the extension requests only the Google Trends host needed by the live feed', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'manifest.json'), 'utf8'));
    assert(manifest.host_permissions.includes('https://trends.google.com/*'));
});

test('live Google Trends RSS becomes the active term cache in a worker without DOMParser', async () => {
    const h = await createHarness();
    assert.equal(h.run('typeof DOMParser'), 'undefined');
    await h.run('trends.getGoogleTrendWords()');
    assert.equal(h.run('trends._termSource'), 'live');
    assert.deepEqual(Array.from(h.run('trends._termCache')).sort(), ['live alpha', 'live beta', 'live gamma']);
    const request = h.requests.find(({url}) => url === feedUrl);
    assert(request);
    assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.cache, 'no-store');
    assert(request.options.signal instanceof AbortSignal);
    assert.equal(h.storage.googleTrendsSource, 'live');
    assert.equal(h.storage.googleTrendsTermCount, 3);
    assert.equal(h.storage.googleTrendsLastError, null);
    assert(Number.isFinite(Date.parse(h.storage.googleTrendsLastFetch)));
});

test('RSS parsing uses item titles, decodes XML entities once, preserves CDATA, and deduplicates', async () => {
    const h = await createHarness({
        liveResponse: async () => ({ok: true, text: async () => rss([
            'A &amp; B &apos;C&apos; &#x1F680; &amp;lt;',
            '<![CDATA[AT&T &amp; <tag>]]>',
            '  live   alpha  ',
            'live alpha',
        ])}),
    });
    await h.run('trends.getGoogleTrendWords()');
    assert.deepEqual(Array.from(h.run('trends._termCache')).sort(), [
        'A & B \'C\' \u{1f680} &lt;',
        'AT&T &amp; <tag>',
        'live alpha',
    ].sort());
});

test('refilling and resetting a live pool never silently switch back to archived terms', async () => {
    const h = await createHarness();
    await h.run('trends.getGoogleTrendWords()');
    const terms = [];
    for (let i = 0; i < 12; i++) terms.push(h.run('trends.nextPCWord'));
    h.run('trends.reset()');
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 6; i++) terms.push(h.run('trends.nextMBWord'));
    assert(terms.every((term) => term.startsWith('live ')));
    assert.equal(h.run('trends._termSource'), 'live');
});

test('previews do not consume terms and each search consumes exactly one term', async () => {
    const h = await createHarness();
    await h.run('trends.getGoogleTrendWords()');
    const preview = await h.run(`trends.getNextTermForDisplayAsync('PC')`);
    assert.equal(await h.run(`trends.getNextTermForDisplayAsync('PC')`), preview);
    assert.equal(h.run('trends.nextPCWord'), preview);
    const nextPreview = h.run('trends.getNextTermForDisplay()');
    assert.equal(h.run('trends.nextMBWord'), nextPreview);
    const third = h.run('trends.nextPCWord');
    assert.equal(new Set([preview, nextPreview, third]).size, 3);
});

test('skipping a term preserves the live source and previews the next real search', async () => {
    const h = await createHarness();
    await h.run('trends.getGoogleTrendWords()');
    const before = await h.run('trends.getNextTermForDisplayAsync()');
    await h.run('trends.skipCurrentTerm()');
    const after = await h.run('trends.getNextTermForDisplayAsync()');
    assert.notEqual(after, before);
    assert.equal(h.run('trends.nextPCWord'), after);
    assert.equal(h.run('trends._termSource'), 'live');
});

test('a remembered CORS failure from the retired endpoint does not suppress live RSS requests', async () => {
    const h = await createHarness({
        storage: {googleTrendsCorsBlocked: true, lastCorsCheck: new Date().toISOString()},
    });
    await h.run('trends.getGoogleTrendWords()');
    assert(h.requests.some(({url}) => url === feedUrl));
    assert.equal(h.storage.googleTrendsSource, 'live');
    assert.equal(h.storage.googleTrendsCorsBlocked, undefined);
});

test('failed live requests explicitly select the archive and retry live on the next run', async () => {
    let failed = true;
    const h = await createHarness({
        liveResponse: async () => {
            if (failed) throw new TypeError('Failed to fetch');
            return {ok: true, text: async () => rss()};
        },
    });
    await h.run('trends.getGoogleTrendWords()');
    assert.equal(h.storage.googleTrendsSource, 'archive');
    assert.match(h.storage.googleTrendsLastError, /Failed to fetch/);
    assert(h.warnings.length > 0);
    assert(backupTerms.includes(h.run('trends.nextPCWord')));
    failed = false;
    await h.run('trends.getGoogleTrendWords()');
    assert.equal(h.storage.googleTrendsSource, 'live');
    assert.equal(h.storage.googleTrendsLastError, null);
    assert(h.run('trends.nextPCWord').startsWith('live '));
});

test('HTTP errors, login pages, empty feeds, and invalid XML entities cannot masquerade as live terms', async () => {
    for (const response of [
        {ok: false, status: 429, statusText: 'Too Many Requests', text: async () => rss()},
        {ok: true, text: async () => '<html><title>Sign in</title></html>'},
        {ok: true, text: async () => rss([])},
        {ok: true, text: async () => rss(['&#x110000;'])},
    ]) {
        const h = await createHarness({liveResponse: async () => response});
        await h.run('trends.getGoogleTrendWords()');
        assert.equal(h.storage.googleTrendsSource, 'archive');
        assert.equal(typeof h.storage.googleTrendsLastError, 'string');
        assert(backupTerms.includes(h.run('trends.nextPCWord')));
        assert.equal(h.requests.filter(({url}) => url.startsWith('https:')).length, 1);
    }
});

test('live fetches have a timeout and concurrent refreshes share a single request', async () => {
    let release;
    const h = await createHarness({
        liveResponse: async (url, options) => new Promise((resolve, reject) => {
            release = () => resolve({ok: true, text: async () => rss()});
            options?.signal?.addEventListener('abort', () => reject(new Error('Request aborted')));
        }),
    });
    const first = h.run('trends.getGoogleTrendWords()');
    const second = h.run('trends.getGoogleTrendWords()');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.requests.filter(({url}) => url.startsWith('https:')).length, 1);
    assert([...h.timers.values()].some(({ms}) => ms === 15000));
    release();
    await Promise.all([first, second]);
    assert.equal(h.storage.googleTrendsSource, 'live');
    assert.equal(h.timers.size, 0);
});

test('a timed-out live feed falls back without leaving its timer running', async () => {
    const h = await createHarness({
        liveResponse: async (url, options) => new Promise((resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('Request aborted')));
        }),
    });
    const refresh = h.run('trends.getGoogleTrendWords()');
    await new Promise((resolve) => setImmediate(resolve));
    const timeout = [...h.timers.values()].find(({ms}) => ms === 15000);
    assert(timeout);
    timeout.fn();
    await refresh;
    assert.equal(h.storage.googleTrendsSource, 'archive');
    assert.equal(h.timers.size, 0);
});

test('late archive initialization cannot overwrite live terms', async () => {
    let release;
    const h = await createHarness({
        backupResponse: async () => new Promise((resolve) => {
            release = () => resolve({ok: true, text: async () => backupTerms.join('\n')});
        }),
    });
    const refresh = h.run('trends.getGoogleTrendWords()');
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await refresh;
    assert.equal(h.run('trends._termSource'), 'live');
    assert(h.run('trends.nextPCWord').startsWith('live '));
});

test('a missing archive cannot prevent successful live extraction', async () => {
    const h = await createHarness({
        backupResponse: async () => ({ok: false, status: 404}),
    });
    await h.run('trends.getGoogleTrendWords()');
    assert.equal(h.storage.googleTrendsSource, 'live');
    assert(h.run('trends.nextPCWord').startsWith('live '));
});

test('unavailable live and archived sources are explicitly labeled as emergency terms', async () => {
    const h = await createHarness({
        backupResponse: async () => ({ok: false, status: 404}),
        liveResponse: async () => ({ok: false, status: 503}),
    });
    await h.run('trends.getGoogleTrendWords()');
    assert.equal(h.storage.googleTrendsSource, 'emergency');
    assert.match(h.storage.googleTrendsLastError, /503/);
    assert(h.warnings.length > 0);
    assert.equal(typeof h.run('trends.nextPCWord'), 'string');
});
