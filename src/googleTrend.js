class GoogleTrend {
    constructor() {
        this._lastUsedTerms = new Set();
        this._availableTerms = []; // Add tracking for available terms
        this._backupTerms = null;
        this.reset();
        this._currentSeed = Date.now(); // Initialize seed
        this._random = this._createRandomGenerator(this._currentSeed);
        this._initializeRandom();
        this._randomCallCount = 0;
        this._loadBackupSearchTerms().catch(err => {
            console.error('Failed to load backup terms during construction:', err);
        });
    }

    get nextPCWord() {
        // Return promise to ensure proper async handling
        return Promise.resolve().then(async () => {
            // Ensure backup terms are loaded
            if (!this._backupTerms) {
                await this._loadBackupSearchTerms();
            }

            const term = this._getRandomSearchTerm();
            console.log(`Selected search term: "${term}" (${this._availableTerms.length} remaining)`);
            return term;
        });
    }

    get nextMBWord() {
        if (this._mbWordPointer_ >= this._googleTrendWords_.words.length-1) {
            this._mbWordPointer_ = -1;
        }
        this._mbWordPointer_ ++;
        const word = this._googleTrendWords_.words[this._mbWordPointer_] || this._getRandomSearchTerm();
        return word;
    }

    reset() {
        this._googleTrendWords_ = {date: '', words: []};
        this._pcWordPointer_ = -1;
        this._mbWordPointer_ = -1;
        this._availableTerms = [];
        this._lastUsedTerms.clear();
    }

    async getGoogleTrendWords() {
        if (this._isGoogleTrendUpToDate()) {
            return;
        }
        
        try {
            if (await this._loadLocalWords()) {
                return;
            }

            const dates = this._getPastThreeDays();
            for (let i = 0; i < 3; i++) {
                await this._fetchGoogleTrend(this._getGoogleTrendUrl(dates[i]));
            }
            await this._saveWordsToLocal();
        } catch (error) {
            console.error('Error getting Google trend words:', error);
            throw error;
        }
    }

    _isGoogleTrendUpToDate(date=this._googleTrendWords_.date) {
        return date == this._getyyyymmdd(new Date());
    }

    async _saveWordsToLocal() {
        await chrome.storage.local.set({
            'googleTrend': this._googleTrendWords_.words.join('|'),
            'googleTrendDate': this._googleTrendWords_.date
        });
    }

    async _loadLocalWords() {
        const result = await chrome.storage.local.get(['googleTrend', 'googleTrendDate']);
        const date = result.googleTrendDate;
        
        if (!date) {
            return false;
        }
        if (!this._isGoogleTrendUpToDate(date)) {
            return false;
        }

        this._googleTrendWords_.date = date;
        this._googleTrendWords_.words = result.googleTrend.split('|');
        return true;
    }

    async _fetchGoogleTrend(url) {
        console.log('Fetching Google Trends from trends API...');
        try {
            const response = await fetch('https://trends.google.com/_/TrendsUi/data/batchexecute', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': 'https://trends.google.com',
                    'Referer': 'https://trends.google.com/trending'
                },
                body: 'rpcids=i0OFE&source-path=/trending&hl=en&geo=US'
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const text = await response.text();
            const matches = text.match(/\[\[\["wrb.fr",.*?\]\]\]/);
            if (!matches) {
                throw new Error('Could not parse trends response');
            }

            const json = JSON.parse(matches[0]);
            const trendData = JSON.parse(json[0][2]);

            this._googleTrendWords_.words = [];
            trendData.forEach(trend => {
                // Add main query
                this._appendWord(trend.title.query);
                
                // Add related queries
                trend.relatedQueries?.forEach(related => {
                    this._appendWord(related.query);
                });
            });

            this._googleTrendWords_.date = this._getyyyymmdd(new Date());
            
            console.log(`Loaded ${this._googleTrendWords_.words.length} search terms`);

            // If we don't have enough terms, add some fallbacks
            if (this._googleTrendWords_.words.length < 50) {
                this._appendFallbackTerms();
            }

        } catch (error) {
            console.error('Failed to fetch trends, attempting to load backup search terms:', error);
            if (!this._backupTerms) {
                await this._loadBackupSearchTerms();
            }
            if (!this._backupTerms?.length) {
                throw new Error('No search terms available - both trends and backup terms failed to load');
            }
            await this._useFallbackTerms();
        }
    }

    _appendFallbackTerms() {
        console.warn('appendFallbackTerms called - this should not happen. Using backup terms instead.');
        this._useFallbackTerms();
    }

    async _useFallbackTerms() {
        console.log('Switching to fallback search terms');
        if (!this._backupTerms) {
            await this._loadBackupSearchTerms();
        }

        this._googleTrendWords_.words = this._getRandomBackupTerms();
        this._googleTrendWords_.date = this._getyyyymmdd(new Date());
        
        console.log('Using fallback terms:', {
            termCount: this._googleTrendWords_.words.length,
            sampleTerms: this._googleTrendWords_.words.slice(0, 3)
        });
    }

    async _loadBackupSearchTerms() {
        if (this._backupTerms?.length > 0) {
            console.log('Using existing backup terms');
            return;
        }

        try {
            console.log('Loading backup search terms from file...');
            const response = await fetch(chrome.runtime.getURL('data/backup-searches.txt'));
            if (!response.ok) {
                throw new Error(`Failed to load backup terms: HTTP ${response.status}`);
            }

            const text = await response.text();
            const terms = text.split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('//'));

            if (!terms?.length) {
                throw new Error('Backup terms file is empty or contains no valid terms');
            }

            this._backupTerms = terms;
            console.log('Loaded backup terms:', {
                count: terms.length,
                sample: terms.slice(0, 5),
                lastUpdated: new Date().toISOString()
            });
            return true;
        } catch (error) {
            console.error('Failed to load backup search terms:', {
                error: error,
                message: error.message,
                stack: error.stack
            });
            throw error; // Propagate error instead of falling back to hardcoded terms
        }
    }

    _getRandomBackupTerms(count = 50) {
        if (!this._backupTerms?.length) {
            return this._getDefaultFallbackTerms();
        }

        console.log('Selecting random backup terms...');
        const terms = [];
        const available = [...this._backupTerms]; // Create copy to shuffle
        
        while (terms.length < count && available.length > 0) {
            // Get random index
            const index = Math.floor(Math.random() * available.length);
            // Remove and add term
            const term = available.splice(index, 1)[0];
            terms.push(term);
        }

        // If we run out of terms, cycle through them again
        if (terms.length < count) {
            console.log('Recycling terms to reach desired count');
            terms.push(...this._getRandomBackupTerms(count - terms.length));
        }

        return terms;
    }

    _getDefaultFallbackTerms() {
        // Don't silently fall back to hardcoded terms
        if (!this._backupTerms?.length) {
            const error = new Error('No backup terms available and backup file failed to load');
            console.error('Critical error:', {
                error: error,
                backupTerms: this._backupTerms,
                stack: error.stack
            });
            throw error;
        }
        
        console.warn('Using terms from backup file instead of trends');
        return [...this._backupTerms]; // Return copy of backup terms
    }

    async _processResponse(response) {
        const text = await response.text();
        if (!text || text.length < 6) {
            throw new Error('Empty response');
        }

        // Remove )]}'` prefix
        const jsonText = text.replace(/^\)\]\}'/, '');
        console.log('Response preview:', jsonText.substring(0, 100));

        const json = JSON.parse(jsonText);
        if (!json?.default?.trendingSearchesDays?.[0]?.trendingSearches) {
            throw new Error('Invalid JSON structure');
        }
        
        this._getWordsFromJSON(json);
    }

    _getPastThreeDays() {
        const dates = [];
        const date = new Date();
        for (let i = 0; i<3; i++) {
            if (i != 0) {
                date.setDate(date.getDate()- 1);
            }
            dates.push(this._getyyyymmdd(date));
        }
        return dates;
    }

    _getyyyymmdd(date) {
        return date.toJSON().slice(0, 10).replace(/-/g, '');
    }

    _getGoogleTrendUrl(yyyymmdd) {
        // Just use fallback terms directly since Google Trends API is unreliable
        this._useFallbackTerms();
        return null;
    }

    _getWordsFromJSON(json) {
        const trends = json['default']['trendingSearchesDays'][0]['trendingSearches'];
        for (let i = 0; i<trends.length; i++) {
            this._appendWord(trends[i]['title']['query']);

            const relatedQueries = trends[i]['relatedQueries'];
            for (let j = 0; j<relatedQueries.length; j++) {
                this._appendWord(relatedQueries[j]['query']);
            }
        }
    }

    _appendWord(word) {
        if (!this._googleTrendWords_.words.includes(word)) {
            this._googleTrendWords_.words.push(word);
        }
    }

    _createRandomGenerator(seed) {
        // Mulberry32 algorithm
        return () => {
            seed = (seed + 0x6D2B79F5) >>> 0;
            let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
            t = (t + Math.imul(t ^ t >>> 7, 61 | t)) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }

    _getNextRandom() {
        this._randomCallCount++;
        let seed = Date.now() + this._randomCallCount;  // Changed from const to let
        const x = Math.sin(seed) * 10000;  // Removed seed++ which was causing the error
        const result = x - Math.floor(x);
        
        console.log(`Random generation #${this._randomCallCount}:`, {
            time: new Date().toISOString(),
            seed: seed,
            result: result.toFixed(4),
            stack: new Error().stack.split('\n')[2]
        });
        
        return result;
    }

    _getRandomSearchTerm() {
        if (!this._backupTerms?.length) {
            throw new Error('No backup terms available');
        }

        // Always rebuild pool if it's empty or small
        if (this._availableTerms.length < 10) {
            console.log('Rebuilding search term pool (current size:', this._availableTerms.length, ')');
            this._availableTerms = [...this._backupTerms];
            this._lastUsedTerms.clear();
            this._currentSeed = Date.now();
            
            console.log('Pre-shuffle sample:', this._availableTerms.slice(0, 3));
            this._shuffleTerms();
            console.log('Post-shuffle sample:', this._availableTerms.slice(0, 3));
        }

        const term = this._availableTerms.pop();
        console.log(`Using random term "${term}" (${this._availableTerms.length} remaining)`);
        return term;
    }

    _shuffleTerms() {
        for (let i = this._availableTerms.length - 1; i > 0; i--) {
            const rand = this._getNextRandom();
            const j = Math.floor(rand * (i + 1));
            console.log(`Shuffle step ${i}:`, {
                rand: rand.toFixed(4),
                index: j,
                termA: this._availableTerms[i],
                termB: this._availableTerms[j],
                seed: this._currentSeed
            });
            [this._availableTerms[i], this._availableTerms[j]] = 
            [this._availableTerms[j], this._availableTerms[i]];
        }
    }

    _seedRandom() {
        this._currentSeed = Date.now();
        console.log(`Creating new random seed: ${this._currentSeed}`);
        this._random = this._createRandomGenerator(this._currentSeed);
        
        // Immediately test the generator
        const testValues = [
            this._random(),
            this._random(),
            this._random()
        ];
        console.log('Random generator test values:', testValues);
    }

    _initializeRandom() {
        this._seed = Date.now();
        console.log(`Initializing random with seed: ${this._seed}`);
        // Advance seed a few times to avoid startup patterns
        for (let i = 0; i < 10; i++) {
            this._nextRandom();
        }
    }

    _nextRandom() {
        // xorshift128+ algorithm
        this._seed = BigInt(this._seed);
        this._seed ^= this._seed << 21n;
        this._seed ^= this._seed >> 35n;
        this._seed ^= this._seed << 4n;
        return Number(this._seed % 100000n) / 100000;
    }
}
