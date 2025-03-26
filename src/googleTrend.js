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
        this._cachedNextTerm = null; // Add a cache for the next term
        this._loadBackupSearchTerms().catch(err => {
            console.error('Failed to load backup terms during construction:', err);
        });
    }

    get nextPCWord() {
        // Return promise to ensure proper async handling
        return Promise.resolve().then(async () => {
            try {
                // Ensure backup terms are loaded
                if (!this._backupTerms) {
                    await this._loadBackupSearchTerms();
                }

                // If we have a cached term, use it and clear it
                if (this._cachedNextTerm) {
                    const term = this._cachedNextTerm;
                    this._cachedNextTerm = null; // Clear the cache after using it
                    
                    // Important: Get a new term for the next search and cache it
                    // This ensures we don't show the same term after using one
                    setTimeout(() => {
                        this._updateCachedNextTerm();
                    }, 100);
                    
                    console.log(`Selected search term: "${term}" (${this._availableTerms.length} remaining)`);
                    return term;
                }

                const term = this._getRandomSearchTerm();
                
                // Important: After getting a random term, immediately cache a new one for next time
                setTimeout(() => {
                    this._updateCachedNextTerm();
                }, 100);
                
                console.log(`Selected search term: "${term}" (${this._availableTerms.length} remaining)`);
                return term;
            } catch (error) {
                console.error('Error in nextPCWord:', error);
                // Return a fallback term in case of error
                return "microsoft rewards"; 
            }
        });
    }

    // Add a method to update the cached next term
    _updateCachedNextTerm() {
        try {
            // Track the current term before replacing it
            const previousTerm = this._cachedNextTerm;
            
            // Initialize permanent history of used terms if not already done
            if (!this._usedTermsHistory) {
                this._usedTermsHistory = new Set();
            }
            
            // Add the previous term to permanently used set
            if (previousTerm) {
                this._usedTermsHistory.add(previousTerm);
            }
            
            // If we're running low on unused terms, rebuild the entire pool
            if (this._availableTerms.length < 20 || !this._availableTerms.length) {
                console.log('Term pool depleted, rebuilding with all remaining unused terms');
                
                // Create a fresh pool using only terms that haven't been used yet
                if (this._backupTerms) {
                    this._availableTerms = this._backupTerms.filter(term => !this._usedTermsHistory.has(term));
                    
                    // If we've used all terms, reset the history and start fresh
                    if (this._availableTerms.length < 10) {
                        console.log('Nearly all terms have been used, resetting usage history');
                        this._usedTermsHistory.clear();
                        this._availableTerms = [...this._backupTerms];
                    }
                    
                    // Always shuffle the available terms for randomness
                    this._currentSeed = Date.now() * (Math.random() + 1);
                    this._shuffleTerms();
                    
                    // Log stats after rebuild
                    console.log(`Term pool rebuilt with ${this._availableTerms.length} unused terms`);
                    console.log('New shuffled sample:', this._availableTerms.slice(0, 5));
                }
            }
            
            // Select a term that hasn't been used before
            if (this._availableTerms.length > 0) {
                // Remove any terms from availableTerms that are already in the used history
                // This is a safety check to ensure perfect term separation
                this._availableTerms = this._availableTerms.filter(term => !this._usedTermsHistory.has(term));
                
                // If there are still terms available, select one randomly
                if (this._availableTerms.length > 0) {
                    const randomIndex = Math.floor(Math.random() * this._availableTerms.length);
                    const nextTerm = this._availableTerms[randomIndex];
                    
                    // Remove this term from available list so it can't be chosen again
                    this._availableTerms.splice(randomIndex, 1);
                    
                    this._cachedNextTerm = nextTerm;
                    console.log(`Cached next term: "${this._cachedNextTerm}" for future display (${this._availableTerms.length} unused terms remaining)`);
                } else {
                    // This should happen very rarely, but handle it just in case
                    console.log('All terms have been used, resetting history');
                    this._usedTermsHistory.clear();
                    this._availableTerms = [...this._backupTerms];
                    this._shuffleTerms();
                    
                    // Pick first term from new shuffled deck
                    this._cachedNextTerm = this._availableTerms.shift();
                    console.log(`Using first term from reset pool: "${this._cachedNextTerm}"`);
                }
            } else {
                // Fallback case - should never happen with proper initialization
                this._cachedNextTerm = "bing search";
                console.warn("No available terms in pool, using fallback term");
            }
        } catch (error) {
            console.error('Error updating cached next term:', error);
            this._cachedNextTerm = "bing search";
        }
    }

    // Add a non-async getter for the UI to display the next term without consuming it
    getNextTermForDisplay() {
        try {
            if (!this._backupTerms || this._backupTerms.length === 0) {
                return "[loading terms...]";
            }
            
            // If we don't have a cached next term, prepare one
            if (!this._cachedNextTerm) {
                this._updateCachedNextTerm();
            }
            
            return this._cachedNextTerm || "[next term]";
        } catch (error) {
            console.error('Error getting next term for display:', error);
            return "[next term]";
        }
    }

    get nextMBWord() {
        try {
            if (this._mbWordPointer_ >= this._googleTrendWords_.words.length-1) {
                this._mbWordPointer_ = -1;
            }
            this._mbWordPointer_ ++;
            const word = this._googleTrendWords_.words[this._mbWordPointer_] || this._getRandomSearchTerm();
            return word;
        } catch (error) {
            console.error('Error in nextMBWord:', error);
            // Return a fallback term in case of error
            return "bing search";
        }
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
            let success = false;
            
            // Try each date, but handle failures gracefully
            for (let i = 0; i < 3 && !success; i++) {
                try {
                    await this._fetchGoogleTrend(this._getGoogleTrendUrl(dates[i]));
                    success = this._googleTrendWords_.words.length > 0;
                } catch (err) {
                    console.warn(`Failed to fetch Google Trends for date ${dates[i]}:`, err);
                    // Continue to next date
                }
            }
            
            // If we got at least some words, save them
            if (this._googleTrendWords_.words.length > 0) {
                await this._saveWordsToLocal();
            } else {
                // Ensure fallback to backup terms
                await this._useFallbackTerms();
            }
        } catch (error) {
            console.error('Error getting Google trend words:', error);
            // Ensure we have backup terms available
            await this._useFallbackTerms();
        }
    }

    _isGoogleTrendUpToDate(date=this._googleTrendWords_.date) {
        return date == this._getyyyymmdd(new Date());
    }

    async _saveWordsToLocal() {
        try {
            await chrome.storage.local.set({
                'googleTrend': this._googleTrendWords_.words.join('|'),
                'googleTrendDate': this._googleTrendWords_.date
            });
        } catch (error) {
            console.error('Error saving Google trend words to local storage:', error);
            // Non-fatal error, we can continue with in-memory words
        }
    }

    async _loadLocalWords() {
        try {
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
        } catch (error) {
            console.error('Error loading local words:', error);
            return false;
        }
    }

    async _fetchGoogleTrend(url) {
        if (!url) {
            console.log('No valid Google Trends URL, using backup terms...');
            await this._useFallbackTerms();
            return;
        }
        
        console.log('Fetching Google Trends data from:', url);
        try {
            // Use a timeout to prevent hanging
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
            
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json'
                },
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                throw new Error(`HTTP error: ${response.status}`);
            }
            
            await this._processResponse(response);
            this._googleTrendWords_.date = this._getyyyymmdd(new Date());
            console.log(`Successfully loaded ${this._googleTrendWords_.words.length} terms from Google Trends`);
            
        } catch (error) {
            console.error('Error fetching Google Trends data:', error);
            console.log('Falling back to backup terms...');
            
            // Ensure backup terms are loaded
            if (!this._backupTerms || this._backupTerms.length === 0) {
                await this._loadBackupSearchTerms().catch(err => {
                    console.error('Failed to load backup terms during fetch error handling:', err);
                    // Initialize an emergency fallback if needed
                    if (!this._backupTerms || this._backupTerms.length === 0) {
                        this._backupTerms = ["microsoft", "bing", "edge", "windows", "office", "xbox"];
                    }
                });
            }
            
            await this._useFallbackTerms();
            this._googleTrendWords_.date = this._getyyyymmdd(new Date());
        }
    }

    _appendFallbackTerms() {
        console.warn('appendFallbackTerms called - this should not happen. Using backup terms instead.');
        this._useFallbackTerms();
    }

    async _useFallbackTerms() {
        console.log('Switching to fallback search terms');
        try {
            if (!this._backupTerms || this._backupTerms.length === 0) {
                await this._loadBackupSearchTerms();
            }

            this._googleTrendWords_.words = this._getRandomBackupTerms();
            this._googleTrendWords_.date = this._getyyyymmdd(new Date());
            
            console.log('Using fallback terms:', {
                termCount: this._googleTrendWords_.words.length,
                sampleTerms: this._googleTrendWords_.words.slice(0, 3)
            });
        } catch (error) {
            console.error('Error using fallback terms:', error);
            // Initialize with emergency fallback terms
            this._googleTrendWords_.words = ["microsoft", "bing", "edge", "windows", "office", "xbox"];
            this._googleTrendWords_.date = this._getyyyymmdd(new Date());
        }
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
            
            // Initialize with emergency fallback
            console.warn('Using emergency fallback terms');
            this._backupTerms = ["microsoft", "bing", "edge", "windows", "office", "xbox", 
                               "surface", "azure", "outlook", "skype", "teams", "onedrive"];
        }
    }

    _getRandomBackupTerms(count = 50) {
        if (!this._backupTerms?.length) {
            console.warn('No backup terms available in _getRandomBackupTerms, using emergency terms');
            this._backupTerms = ["microsoft", "bing", "edge", "windows", "office", "xbox", 
                               "surface", "azure", "outlook", "skype", "teams", "onedrive"];
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
            console.warn('No backup terms available in _getDefaultFallbackTerms, using emergency terms');
            this._backupTerms = ["microsoft", "bing", "edge", "windows", "office", "xbox", 
                                "surface", "azure", "outlook", "skype", "teams", "onedrive"];
        }
        
        console.warn('Using terms from backup file instead of trends');
        return [...this._backupTerms]; // Return copy of backup terms
    }

    async _processResponse(response) {
        try {
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
        } catch (error) {
            console.error('Error processing response:', error);
            throw error; // Re-throw to be handled by caller
        }
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
        // Use Google Trends API for Daily Trends
        // Note: This URL might face CORS issues, we handle that in _fetchGoogleTrend
        return `https://trends.google.com/trends/api/dailytrends?hl=en-US&tz=-420&geo=US&ns=15&ed=${yyyymmdd}`;
    }

    _getWordsFromJSON(json) {
        try {
            const trends = json['default']['trendingSearchesDays'][0]['trendingSearches'];
            for (let i = 0; i<trends.length; i++) {
                this._appendWord(trends[i]['title']['query']);

                const relatedQueries = trends[i]['relatedQueries'];
                for (let j = 0; j<relatedQueries.length; j++) {
                    this._appendWord(relatedQueries[j]['query']);
                }
            }
        } catch (error) {
            console.error('Error parsing JSON data:', error);
            throw error; // Re-throw to be handled by caller
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
        let seed = Date.now() + this._randomCallCount;
        const x = Math.sin(seed) * 10000;
        const result = x - Math.floor(x);
        
        return result;
    }

    _getRandomSearchTerm() {
        try {
            if (!this._backupTerms?.length) {
                throw new Error('No backup terms available');
            }

            // Always rebuild pool if it's empty or small
            if (this._availableTerms.length < 10) {
                console.log(`Rebuilding search term pool (size: ${this._availableTerms.length})`);
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
        } catch (error) {
            console.error('Error in _getRandomSearchTerm:', error);
            // Return emergency fallback term
            return "microsoft rewards";
        }
    }

    _shuffleTerms() {
        console.log('Starting term shuffle...');
        try {
            for (let i = this._availableTerms.length - 1; i > 0; i--) {
                const rand = this._getNextRandom();
                const j = Math.floor(rand * (i + 1));
                [this._availableTerms[i], this._availableTerms[j]] = 
                [this._availableTerms[j], this._availableTerms[i]];
            }
            console.log('Shuffle complete');
        } catch (error) {
            console.error('Error shuffling terms:', error);
            // Not fatal, continue with unshuffled terms
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
        try {
            // xorshift128+ algorithm
            this._seed = BigInt(this._seed);
            this._seed ^= this._seed << 21n;
            this._seed ^= this._seed >> 35n;
            this._seed ^= this._seed << 4n;
            return Number(this._seed % 100000n) / 100000;
        } catch (error) {
            console.error('Error in _nextRandom:', error);
            // Return a fallback random value
            return Math.random();
        }
    }
}
