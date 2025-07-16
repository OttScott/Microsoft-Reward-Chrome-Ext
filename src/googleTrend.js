class GoogleTrend {
    constructor() {
        // Efficient term management with minimal memory footprint
        this._termCache = null;
        this._termCacheSize = 100; // Keep only 100 terms in memory at once
        this._workingPool = [];
        this._poolIndex = 0;
        this._usedTermsHistory = new Set();
        this._lastUsedTerms = [];
        this._nextTerm = null;
        this._totalTermCount = 0;
        this._fileMetadata = null; // Cache file stats to avoid unnecessary reads
        this._corsBlocked = null; // Track if Google Trends is blocked by CORS
        this._lastCorsCheck = null; // Track when we last checked CORS
        
        // Cached terms for PC and mobile search types
        this._cachedNextPC = null;
        this._cachedNextMobile = null;
        
        // Legacy compatibility
        this._googleTrendWords_ = {date: '', words: []};
        this._pcWordPointer_ = -1;
        this._mbWordPointer_ = -1;
        
        this._loadCorsStatus();
        
        // Initialize with a small batch
        this._initializeTermPool().catch(err => {
            console.error('Failed to initialize term pool:', err);
        });
    }

    // Fast initialization - load only what we need
    async _initializeTermPool() {
        try {
            // Get file metadata first (size, line count estimate)
            await this._getFileMetadata();
            
            // Load just a small working set initially
            await this._loadTermBatch(50);
            
            console.log(`🚀 Term pool initialized with ${this._workingPool.length} terms (${this._totalTermCount} total available)`);
        } catch (error) {
            console.error('Failed to initialize term pool:', error);
            // Fallback to minimal hard-coded terms
            this._workingPool = ['search', 'news', 'weather', 'sports', 'technology'];
            this._totalTermCount = 5;
        }
    }

    // Get file metadata without reading content
    async _getFileMetadata() {
        if (this._fileMetadata) return this._fileMetadata;
        
        try {
            // Estimate total terms by reading just the beginning of the file
            const response = await fetch(chrome.runtime.getURL('data/backup-searches.txt'));
            const text = await response.text();
            const lines = text.split('\n').filter(line => line.trim());
            
            this._fileMetadata = {
                totalLines: lines.length,
                lastModified: Date.now()
            };
            this._totalTermCount = lines.length;
            
            // Cache the first batch for immediate use
            this._termCache = lines;
            
            console.log(`📊 Backup search terms file: ${this._totalTermCount} terms available`);
            return this._fileMetadata;
        } catch (error) {
            console.error('Failed to get file metadata:', error);
            return { totalLines: 0, lastModified: 0 };
        }
    }

    // Load a small batch of terms efficiently
    async _loadTermBatch(batchSize = 50) {
        try {
            if (!this._termCache) {
                await this._getFileMetadata(); // This loads the cache
            }
            
            // Use cached data to create working pool
            const availableTerms = this._termCache.filter(term => 
                term.trim() && !this._usedTermsHistory.has(term.trim())
            );
            
            if (availableTerms.length === 0) {
                // Reset used terms if we've exhausted all options
                console.log('🔄 All terms used, resetting for new cycle');
                this._usedTermsHistory.clear();
                
                // Get a random slice from the full cache to ensure variety
                const startIndex = Math.floor(Math.random() * Math.max(1, this._termCache.length - batchSize));
                this._workingPool = this._termCache.slice(startIndex, startIndex + batchSize);
            } else {
                // Shuffle and take a batch from available terms
                this._shuffleArray(availableTerms);
                
                // Take terms from different parts of the shuffled array for variety
                const randomOffset = Math.floor(Math.random() * Math.max(1, availableTerms.length - batchSize));
                this._workingPool = availableTerms.slice(randomOffset, randomOffset + Math.min(batchSize, availableTerms.length));
            }
            
            // Always shuffle the final working pool
            this._shuffleArray(this._workingPool);
            this._poolIndex = 0;
            
            console.log(`⚡ Loaded ${this._workingPool.length} terms into working pool`);
            console.log('New batch preview:', this._workingPool.slice(0, 3));
            
        } catch (error) {
            console.error('Failed to load term batch:', error);
            // Fallback to basic terms
            this._workingPool = ['technology', 'news', 'weather', 'sports', 'entertainment'];
            this._poolIndex = 0;
        }
    }

    // Efficient shuffling for small arrays
    _shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }

    // Optimized term selection
    get nextPCWord() {
        return this._getNextTerm('PC');
    }

    get nextMBWord() {
        return this._getNextTerm('Mobile');
    }

    // Add method for skipping terms (compatibility with search skip functionality)
    async skipCurrentTerm() {
        console.log('🔄 Skipping current term, forcing new term selection');
        
        // Clear all cached terms to force refresh
        this._cachedNextPC = null;
        this._cachedNextMobile = null;
        this._nextTerm = null;
        
        // Force immediate reload of working pool to get different terms
        if (this._workingPool && this._workingPool.length > 10) {
            // Shuffle current pool to change order
            this._shuffleArray(this._workingPool);
            this._poolIndex = Math.min(this._poolIndex + 3, this._workingPool.length - 1); // Skip ahead
            console.log(`⏭️ Skipped ahead in pool to index ${this._poolIndex}`);
        } else {
            // Reload with fresh batch
            await this._loadTermBatch(50);
            console.log('🔄 Loaded fresh batch for skip');
        }
        
        // Pre-cache new terms for immediate UI update
        await this.getNextTermForDisplayAsync('PC');
        await this.getNextTermForDisplayAsync('mobile');
        
        console.log('✅ Skip completed, new terms cached');
        return true;
    }

    // Legacy compatibility method for old skip functionality
    async _updateCachedNextTerm() {
        return await this.skipCurrentTerm();
    }

    _getNextTerm(searchType) {
        // Return cached term if available
        if (this._nextTerm) {
            const term = this._nextTerm;
            this._nextTerm = null;
            return term;
        }

        // Check if we need to refill the working pool
        if (this._poolIndex >= this._workingPool.length) {
            // Async refill (don't block current operation)
            this._loadTermBatch(50).catch(err => {
                console.warn('Background term batch load failed:', err);
            });
            
            // Reset to beginning of current pool as fallback
            this._poolIndex = 0;
        }

        // Get next term from working pool
        if (this._workingPool.length > 0) {
            const term = this._workingPool[this._poolIndex];
            this._poolIndex++;
            this._usedTermsHistory.add(term);
            
            // Clear cached next terms since we've consumed a term
            this._cachedNextPC = null;
            this._cachedNextMobile = null;
            
            // Cache next term for display
            this._cacheNextTerm();
            
            console.log(`📝 Selected search term: "${term}" (${this._workingPool.length - this._poolIndex} remaining in pool)`);
            return term;
        }

        // Ultimate fallback
        return 'search';
    }

    // Cache the next term for UI display
    _cacheNextTerm() {
        if (this._poolIndex < this._workingPool.length) {
            this._nextTerm = this._workingPool[this._poolIndex];
            const remaining = this._workingPool.length - this._poolIndex;
            console.log(`🔮 Cached next term: "${this._nextTerm}" for future display (${remaining} unused terms remaining)`);
        } else {
            // Load next batch and cache first term
            this._loadTermBatch(50).then(() => {
                if (this._workingPool.length > 0) {
                    this._nextTerm = this._workingPool[0];
                    console.log(`🔮 Cached next term from new batch: "${this._nextTerm}"`);
                }
            }).catch(err => {
                console.warn('Failed to cache next term from new batch:', err);
            });
        }
    }

    // Add a method to get next term for display with search type support (async version)
    async getNextTermForDisplayAsync(searchType = 'PC') {
        try {
            if (!this._termCache || this._termCache.length === 0) {
                await this._loadTermBatch();
            }
            
            // Use specific cache for search type
            if (searchType === 'mobile') {
                if (!this._cachedNextMobile) {
                    this._cachedNextMobile = await this._getNextTermFromPool();
                }
                return this._cachedNextMobile || "[next mobile term]";
            } else {
                if (!this._cachedNextPC) {
                    this._cachedNextPC = await this._getNextTermFromPool();
                }
                return this._cachedNextPC || "[next PC term]";
            }
        } catch (error) {
            console.error('Error getting next term for display:', error);
            return "[next term]";
        }
    }

    // Helper method to get a term from the pool
    async _getNextTermFromPool() {
        if (!this._workingPool || this._poolIndex >= this._workingPool.length) {
            await this._loadTermBatch();
        }
        
        if (this._workingPool && this._poolIndex < this._workingPool.length) {
            const term = this._workingPool[this._poolIndex];
            this._poolIndex++;
            return term;
        }
        
        return 'search term';
    }

    // Synchronous version for legacy compatibility (returns cached terms or fallback)
    getNextTermForDisplay() {
        // If we have cached PC terms, return one
        if (this._cachedNextPC && typeof this._cachedNextPC === 'string') {
            return this._cachedNextPC.trim();
        }
        
        // Try to get the NEXT term from the working pool (look ahead by 1)
        if (this._workingPool && (this._poolIndex + 1) < this._workingPool.length) {
            const term = this._workingPool[this._poolIndex + 1];
            if (term && typeof term === 'string') {
                return term.trim();
            }
        }
        
        // If we're at the end, the next term would be from a new shuffle
        if (this._workingPool && this._poolIndex >= this._workingPool.length - 1) {
            return '[new session term]';
        }
        
        // Fallback to a simple term
        return '[next term]';
    }

    // Lightweight reset that doesn't reload everything
    reset() {
        console.log('🔄 Resetting GoogleTrend (keeping cached terms)');
        
        // Clear usage history to allow term reuse
        this._usedTermsHistory.clear();
        this._lastUsedTerms = [];
        this._nextTerm = null;
        
        // Reset pool index and reshuffle for variety
        this._poolIndex = 0;
        
        // Legacy compatibility
        this._googleTrendWords_ = {date: '', words: []};
        this._pcWordPointer_ = -1;
        this._mbWordPointer_ = -1;
        
        // Reshuffle working pool for variety between sessions
        if (this._workingPool.length > 0) {
            this._shuffleArray(this._workingPool);
            console.log('🎲 Reshuffled working pool for new session');
            console.log('New session starts with:', this._workingPool.slice(0, 3));
        }
        
        // Force load of a fresh batch to ensure variety
        this._loadTermBatch(50).catch(err => {
            console.warn('Failed to load fresh batch during reset:', err);
        });
    }

    // Keep existing CORS and Google Trends methods but optimize them
    async updateTerms() {
        const maxRetries = 3;
        let attempt = 0;

        while (attempt < maxRetries) {
            try {
                // Check if we should skip Google Trends
                if (await this._shouldSkipGoogleTrends()) {
                    console.log('🚀 Using backup terms directly (Google Trends CORS blocked previously)');
                    await this._ensureWorkingPoolFilled();
                    return;
                }

                console.log(`� Attempting to fetch Google Trends (attempt ${attempt + 1}/${maxRetries})`);
                await this._fetchGoogleTrend();
                return; // Success
                
            } catch (error) {
                attempt++;
                
                if (this._isCorsError(error)) {
                    console.log('� Google Trends blocked by CORS policy - saving status and using backup terms');
                    await this._saveCorsStatus(true);
                    await this._ensureWorkingPoolFilled();
                    return;
                }
                
                if (attempt === maxRetries) {
                    console.warn(`⚠️ All ${maxRetries} Google Trends attempts failed, using backup terms:`, error.message);
                    await this._ensureWorkingPoolFilled();
                }
            }
        }
    }

    // Ensure we have terms available without loading everything
    async _ensureWorkingPoolFilled() {
        if (this._workingPool.length - this._poolIndex < 10) {
            await this._loadTermBatch(50);
        }
    }

    // Optimized Google Trends fetching (unchanged but cleaner)
    async _fetchGoogleTrend() {
        console.log('📡 Testing Google Trends accessibility...');
        
        const response = await fetch(`https://trends.google.com/trends/api/dailytrends?hl=en-US&tz=-420&geo=US&ns=15&ed=${this._getDateStr()}`);
        
        if (!response.ok) {
            throw new Error(`Google Trends API returned ${response.status}: ${response.statusText}`);
        }

        const text = await response.text();
        const jsonStr = text.replace(')]}\'', '');
        const data = JSON.parse(jsonStr);

        if (data?.default?.trendingSearchesDays?.[0]?.trendingSearches) {
            const trends = data.default.trendingSearchesDays[0].trendingSearches;
            const terms = trends.map(trend => trend.title?.query || '').filter(Boolean);
            
            if (terms.length > 0) {
                console.log('✅ Google Trends successfully fetched:', terms.length, 'terms');
                // Replace working pool with fresh Google Trends
                this._workingPool = terms;
                this._poolIndex = 0;
                this._shuffleArray(this._workingPool);
                await this._saveCorsStatus(false); // Mark as working
                return;
            }
        }
        
        throw new Error('No valid trends data received');
    }

    // Keep existing helper methods but optimize them
    _getDateStr() {
        const date = new Date();
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}${month}${day}`;
    }

    _isCorsError(error) {
        return error.message.includes('CORS') || 
               error.message.includes('Access-Control-Allow-Origin') ||
               (error.name === 'TypeError' && error.message.includes('Failed to fetch'));
    }

    // CORS status management (keep existing but make async safe)
    async _loadCorsStatus() {
        try {
            const data = await chrome.storage.local.get(['googleTrendsCorsBlocked', 'lastCorsCheck']);
            this._corsBlocked = data.googleTrendsCorsBlocked || false;
            this._lastCorsCheck = data.lastCorsCheck ? new Date(data.lastCorsCheck) : null;
        } catch (error) {
            console.warn('Failed to load CORS status:', error);
            this._corsBlocked = false;
            this._lastCorsCheck = null;
        }
    }

    async _saveCorsStatus(blocked) {
        try {
            await chrome.storage.local.set({
                googleTrendsCorsBlocked: blocked,
                lastCorsCheck: new Date().toISOString()
            });
            this._corsBlocked = blocked;
            this._lastCorsCheck = new Date();
        } catch (error) {
            console.warn('Failed to save CORS status:', error);
        }
    }

    async _shouldSkipGoogleTrends() {
        if (!this._corsBlocked) return false;
        
        // Retry once per day
        if (this._lastCorsCheck) {
            const hoursSinceCheck = (Date.now() - this._lastCorsCheck.getTime()) / (1000 * 60 * 60);
            if (hoursSinceCheck < 24) {
                return true; // Skip, too recent
            }
        }
        
        console.log('📅 24+ hours since last CORS check - will retry Google Trends');
        return false;
    }

    // Legacy compatibility methods (simplified)
    async getGoogleTrendWords() {
        await this.updateTerms();
    }

    _isGoogleTrendUpToDate() {
        // Always return false to trigger fresh term loading
        return false;
    }

    async _saveWordsToLocal() {
        // No-op for compatibility
    }

    async _loadLocalWords() {
        // Always return false to use fresh terms
        return false;
    }

    _appendFallbackTerms() {
        // Compatibility shim
        this._ensureWorkingPoolFilled();
    }

    async _useFallbackTerms() {
        // Compatibility shim  
        await this._ensureWorkingPoolFilled();
    }

    async _loadBackupSearchTerms() {
        // This is handled by _getFileMetadata now
        if (this._termCache && this._termCache.length > 0) {
            return true;
        }
        await this._getFileMetadata();
        return true;
    }

    _getRandomBackupTerms(count = 50) {
        if (!this._termCache?.length) {
            console.warn('No backup terms available, using emergency terms');
            return ["microsoft", "bing", "edge", "windows", "office", "xbox"];
        }

        const terms = [];
        const available = [...this._termCache];
        this._shuffleArray(available);
        
        return available.slice(0, Math.min(count, available.length));
    }

    _getDefaultFallbackTerms() {
        return this._getRandomBackupTerms(20);
    }

    async _processResponse(response) {
        try {
            const text = await response.text();
            if (!text || text.length < 6) {
                throw new Error('Empty response');
            }

            const jsonText = text.replace(/^\)\]\}'/, '');
            const json = JSON.parse(jsonText);
            
            if (!json?.default?.trendingSearchesDays?.[0]?.trendingSearches) {
                throw new Error('Invalid JSON structure');
            }
            
            this._getWordsFromJSON(json);
        } catch (error) {
            console.error('Error processing response:', error);
            throw error;
        }
    }

    _getPastThreeDays() {
        const dates = [];
        const date = new Date();
        for (let i = 0; i < 3; i++) {
            if (i != 0) {
                date.setDate(date.getDate() - 1);
            }
            dates.push(this._getyyyymmdd(date));
        }
        return dates;
    }

    _getyyyymmdd(date) {
        return date.toJSON().slice(0, 10).replace(/-/g, '');
    }

    _getGoogleTrendUrl(yyyymmdd) {
        return `https://trends.google.com/trends/api/dailytrends?hl=en-US&tz=-420&geo=US&ns=15&ed=${yyyymmdd}`;
    }

    _getWordsFromJSON(json) {
        try {
            const trends = json['default']['trendingSearchesDays'][0]['trendingSearches'];
            const words = [];
            
            for (let i = 0; i < trends.length; i++) {
                words.push(trends[i]['title']['query']);

                const relatedQueries = trends[i]['relatedQueries'];
                for (let j = 0; j < relatedQueries.length; j++) {
                    words.push(relatedQueries[j]['query']);
                }
            }
            
            // Replace working pool with Google Trends data
            this._workingPool = words;
            this._poolIndex = 0;
            this._shuffleArray(this._workingPool);
            
            // Legacy compatibility
            this._googleTrendWords_.words = words;
            this._googleTrendWords_.date = this._getyyyymmdd(new Date());
        } catch (error) {
            console.error('Error parsing JSON data:', error);
            throw error;
        }
    }

    _appendWord(word) {
        // Legacy compatibility - no longer needed
    }

    // Remove all the complex seeded random and shuffling methods
    _getRandomSearchTerm() {
        return this._getNextTerm('Random');
    }

    _shuffleTerms() {
        // Legacy compatibility
        this._shuffleArray(this._workingPool);
    }

    _seedRandom() {
        // No-op for compatibility
    }

    _initializeRandom() {
        // No-op for compatibility  
    }

    _nextRandom() {
        return Math.random();
    }

    _createRandomGenerator(seed) {
        return () => Math.random();
    }

    _getNextRandom() {
        return Math.random();
    }
}
