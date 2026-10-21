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
        this._backupTerms = null;
        this._termSource = null;
        this._updateTermsPromise = null;
        
        // Cached terms for PC and mobile search types
        this._cachedNextPC = null;
        this._cachedNextMobile = null;
        
        // Legacy compatibility
        this._googleTrendWords_ = {date: '', words: []};
        this._pcWordPointer_ = -1;
        this._mbWordPointer_ = -1;
        
        // Initialize with a small batch
        this._initializationPromise = this._initializeTermPool();
    }

    // Fast initialization - load only what we need
    async _initializeTermPool() {
        try {
            await this._getFileMetadata();
            this._termSource = 'archive';
            
            // Load just a small working set initially
            await this._loadTermBatch(50);
            
            console.log(`🚀 Term pool initialized with ${this._workingPool.length} terms (${this._totalTermCount} total available)`);
        } catch (error) {
            console.error('Failed to initialize term pool:', error);
            // Fallback to minimal hard-coded terms
            this._workingPool = ['search', 'news', 'weather', 'sports', 'technology'];
            this._termCache = [...this._workingPool];
            this._termSource = 'emergency';
            this._totalTermCount = 5;
        }
    }

    // Keep the packaged archive separate from the active term source.
    async _getFileMetadata() {
        if (this._fileMetadata) return this._fileMetadata;
        
        try {
            const response = await fetch(chrome.runtime.getURL('data/backup-searches.txt'));
            if (!response.ok) throw new Error(`Archived search terms returned HTTP ${response.status}.`);
            const text = await response.text();
            const lines = [...new Set(text.split('\n').map((line) => line.trim()).filter(Boolean))];
            if (!lines.length) throw new Error('The archived search term list is empty.');
            
            this._fileMetadata = {
                totalLines: lines.length,
                lastModified: Date.now()
            };
            this._backupTerms = lines;
            if (!this._termCache) {
                this._termCache = lines;
                this._totalTermCount = lines.length;
            }
            
            console.log(`📊 Backup search terms file: ${this._totalTermCount} terms available`);
            return this._fileMetadata;
        } catch (error) {
            console.error('Failed to get file metadata:', error);
            throw error;
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
            this._nextTerm = null;
            this._cachedNextPC = null;
            this._cachedNextMobile = null;
            
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
        await this._initializationPromise;
        
        // Clear all cached terms to force refresh
        this._cachedNextPC = null;
        this._cachedNextMobile = null;
        this._nextTerm = null;
        
        if (this._poolIndex >= this._workingPool.length) await this._loadTermBatch(50);
        this._usedTermsHistory.add(this._workingPool[this._poolIndex]);
        this._poolIndex++;
        if (this._poolIndex >= this._workingPool.length) await this._loadTermBatch(50);
        
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
        this._nextTerm = this._workingPool[this._poolIndex] || null;
    }

    // Add a method to get next term for display with search type support (async version)
    async getNextTermForDisplayAsync(searchType = 'PC') {
        try {
            await this._initializationPromise;
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
        
        if (this._workingPool && this._poolIndex < this._workingPool.length) {
            const term = this._workingPool[this._poolIndex];
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
        this._cachedNextPC = null;
        this._cachedNextMobile = null;
        
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

    async updateTerms() {
        if (!this._updateTermsPromise) {
            this._updateTermsPromise = this._updateTerms().finally(() => {
                this._updateTermsPromise = null;
            });
        }
        return this._updateTermsPromise;
    }

    async _updateTerms() {
        await this._initializationPromise;
        try {
            await this._fetchGoogleTrend();
        } catch (error) {
            console.warn('Live Google Trends RSS unavailable; falling back to archived search terms:', error.message);
            await this._useFallbackTerms(error.message);
        }
    }

    // Ensure we have terms available without loading everything
    async _ensureWorkingPoolFilled() {
        if (this._workingPool.length - this._poolIndex < 10) {
            await this._loadTermBatch(50);
        }
    }

    async _fetchGoogleTrend() {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch('https://trends.google.com/trending/rss?geo=US', {
                credentials: 'omit',
                cache: 'no-store',
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new Error(`Google Trends RSS returned HTTP ${response.status}.`);
            }
            const terms = GoogleTrend._getWordsFromRSS(await response.text());
            this._termCache = terms;
            this._termSource = 'live';
            this._totalTermCount = terms.length;
            this._usedTermsHistory.clear();
            await this._loadTermBatch(50);
            await this._saveTermStatus();
            console.log(`[GoogleTrends] Using ${terms.length} live US trending searches from Google's RSS feed.`);
        } finally {
            clearTimeout(timeout);
        }
    }

    static _getWordsFromRSS(text) {
        if (!/<rss(?:\s|>)/i.test(text) || !/<channel(?:\s|>)/i.test(text)) {
            throw new Error('Google Trends did not return an RSS feed.');
        }
        const terms = [];
        const entities = {amp: '&', lt: '<', gt: '>', quot: '"', apos: '\''};
        // MV3 workers have no DOMParser; only read titles within RSS items.
        for (const item of text.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi)) {
            const title = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i.exec(item[1]);
            if (!title) continue;
            const term = title[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>|&([^;]+);/g, (match, cdata, entity) => {
                if (cdata !== undefined) return cdata;
                if (Object.hasOwn(entities, entity)) return entities[entity];
                if (/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(entity)) {
                    const hex = entity[1].toLowerCase() === 'x';
                    const point = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
                    if (point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff)) {
                        return String.fromCodePoint(point);
                    }
                }
                throw new Error('Google Trends RSS contains an unsupported XML entity.');
            }).replace(/\s+/g, ' ').trim();
            if (term) terms.push(term);
        }
        if (!terms.length) throw new Error('Google Trends RSS contains no search terms.');
        return [...new Set(terms)];
    }

    async _saveTermStatus(error = null) {
        try {
            const status = {
                googleTrendsSource: this._termSource,
                googleTrendsTermCount: this._totalTermCount,
                googleTrendsLastAttempt: new Date().toISOString(),
                googleTrendsLastError: error,
            };
            if (this._termSource === 'live') status.googleTrendsLastFetch = new Date().toISOString();
            await chrome.storage.local.set(status);
            await chrome.storage.local.remove(['googleTrendsCorsBlocked', 'lastCorsCheck']);
        } catch (error) {
            console.warn('Failed to save Google Trends source diagnostics:', error);
        }
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

    async _useFallbackTerms(error = null) {
        try {
            await this._getFileMetadata();
            this._termCache = this._backupTerms;
            this._termSource = 'archive';
        } catch (archiveError) {
            console.error('Archived terms also unavailable; using emergency search terms:', archiveError);
            this._termCache = ['search', 'news', 'weather', 'sports', 'technology'];
            this._termSource = 'emergency';
        }
        this._totalTermCount = this._termCache.length;
        this._usedTermsHistory.clear();
        await this._loadTermBatch(50);
        await this._saveTermStatus(error);
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
