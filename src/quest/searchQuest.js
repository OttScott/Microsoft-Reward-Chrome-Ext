class SearchQuest {
    constructor(googleTrend) {
        this._googleTrend_ = googleTrend;
        this.reset();
        this._loadSearchSettings();
        this._targetSearchCount = null;
        this._nextSearchTime = null;
        this._searchStartTime = null;
        this._initializationAttempts = 0;
    }

    reset() {
        this._status_ = null;
        this._pcSearchWordIdx_ = 0;
        this._mbSearchWordIdx_ = 0;
        this._currentSearchCount_ = 0;
        this._currentSearchType_ = null;
        this._jobStatus_ = STATUS_NONE;
        this._targetSearchCount = null; // Clear target count to force recalculation
        
        // When resetting, recalculate search interval for variety
        this._loadSearchSettings().then(() => {
            console.log('Search settings reloaded during reset with new randomization');
        }).catch(err => {
            console.error('Failed to reload search settings during reset:', err);
        });
    }

    get jobStatus() {
        return this._jobStatus_;
    }

    async doWork(status) {
        console.assert(status != null);
        
        // Add retry logic for initialization
        let maxAttempts = 3;
        while (!status.summary.isValid && this._initializationAttempts < maxAttempts) {
            console.log('Waiting for status to initialize...', {
                attempt: this._initializationAttempts + 1,
                maxAttempts: maxAttempts
            });
            
            // Wait for status to update
            await status.update();
            await new Promise(resolve => setTimeout(resolve, 2000));
            this._initializationAttempts++;
        }

        if (!status.summary.isValid) {
            console.error('Failed to initialize status after retries');
            this._jobStatus_ = STATUS_ERROR;
            throw new Error('Status initialization failed');
        }

        this._status_ = status;
        this._jobStatus_ = STATUS_BUSY;
        try {
            await getUA();
            await this._googleTrend_.getGoogleTrendWords();
            await this._doWorkLoop();
        } catch (ex) {
            this._jobStatus_ = STATUS_ERROR;
            if (ex instanceof UserAgentInvalidException) {
                notifyUpdatedUAOutdated();
            }
            throw ex;
        }
    }

    async _doWorkLoop() {
        // Add guard against infinite loops
        let loopGuard = 0;
        const MAX_LOOPS = 5;

        while (true) {
            // Increment loop counter
            loopGuard++;
            
            // Break if we've looped too many times without progress
            if (loopGuard > MAX_LOOPS) {
                console.error('Loop guard triggered - possible infinite loop detected');
                this._jobStatus_ = STATUS_ERROR;
                return;
            }
            
            // First check if all searches are already completed
            if (this._status_.pcSearchStatus.isCompleted && 
                (this._status_.mbSearchStatus.isCompleted || this._status_.mbSearchStatus.isValid === false)) {
                console.log('All searches already completed');
                this._jobStatus_ = STATUS_DONE;
                return;
            }

            // Check for invalid status
            if (this._status_.jobStatus == STATUS_ERROR || !this._status_.summary.isValid) {
                this._jobStatus_ = STATUS_ERROR;
                return;
            }

            try {
                await this._startSearchQuests();
                
                // Check if actual searches were performed
                if (this._currentSearchCount_ > 0) {
                    // Reset loop guard since we made progress
                    loopGuard = 0;
                }

                const flag = await this.isSearchSuccessful();
                if (flag > 0) {
                    await this._getAlternativeUA(flag);
                }
                
                // Add delay between attempts to prevent rapid retries
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                console.error('Error in search work loop:', error);
                this._jobStatus_ = STATUS_ERROR;
                return;
            }
        }
    }

    async _startSearchQuests() {
        // Check if searches are already completed before starting
        if (this._status_.pcSearchStatus.isCompleted && 
            (this._status_.mbSearchStatus.isCompleted || this._status_.mbSearchStatus.isValid === false)) {
            console.log('All searches already completed, skipping search quests');
            this._jobStatus_ = STATUS_DONE;
            return;
        }

        // Do PC searches if not completed
        if (!this._status_.pcSearchStatus.isCompleted) {
            await this._doPcSearch();
        }
        
        // Check settings and do mobile searches if enabled and not completed
        const settings = await chrome.storage.sync.get({ disableMobile: false });
        if (!settings.disableMobile && !this._status_.mbSearchStatus.isCompleted) {
            await this._doMbSearch();
        } else {
            console.log('Mobile searches disabled in settings or already completed');
        }
        
        this._quitSearchCleanUp();
    }

    async isSearchSuccessful() {
        // Return:
        // 0 - successful; 1 - pc search failed; 2 - mb search failed; 3 - both failed
        const pcSearchProgBefore = this._status_.pcSearchStatus.progress;
        const mbSearchProgBefore = this._status_.mbSearchStatus.progress;
        
        console.log('Search progress before update:', {
            pc: pcSearchProgBefore,
            mobile: mbSearchProgBefore
        });
        
        try {
            await this._status_.update();
        } catch (error) {
            console.error('Error updating status after search:', error);
            // If we can't update status, don't mark as failed yet
            return 0;
        }
        
        console.log('Search progress after update:', {
            pc: this._status_.pcSearchStatus.progress,
            mobile: this._status_.mbSearchStatus.progress
        });

        // Only count as failed if progress is the same AND we have valid status
        const pcFailed = !this._status_.pcSearchStatus.isValidAndCompleted && 
            this._status_.pcSearchStatus.isValid && // Only consider failure if status is valid
            (pcSearchProgBefore == this._status_.pcSearchStatus.progress);
            
        const mbFailed = !this._status_.mbSearchStatus.isValidAndCompleted && 
            this._status_.mbSearchStatus.isValid && // Only consider failure if status is valid
            (mbSearchProgBefore == this._status_.mbSearchStatus.progress);

        return (pcFailed ? 1 : 0) + (mbFailed ? 2 : 0);
    }

    async _getAlternativeUA(flag) {
        // Add retry counter to prevent infinite loop
        if (!this._uaRetryCount) {
            this._uaRetryCount = 0;
        }
        
        this._uaRetryCount++;
        
        // If we've tried too many times, use the fallback UA directly
        if (this._uaRetryCount > 3) {
            console.warn(`Too many UA update attempts (${this._uaRetryCount}), using fallback UAs`);
            await this._applyFallbackUserAgents(flag);
            return;
        }
        
        try {
            if (flag == 3) {
                if (userAgents.pcSource == 'updated' && userAgents.mbSource == 'updated') {
                    console.error('Both PC and Mobile UAs failed even after update, using fallback UAs');
                    await this._applyFallbackUserAgents(3);
                    return;
                }
                await getUpdatedUA('both');
            } else if (flag == 1) {
                if (userAgents.pcSource == 'updated') {
                    console.error('PC UA failed even after update, using fallback UA');
                    await this._applyFallbackUserAgents(1);
                    return;
                }
                await getUpdatedUA('pc');
            } else if (flag == 2) {
                if (userAgents.mbSource == 'updated') {
                    console.error('Mobile UA failed even after update, using fallback UA');
                    await this._applyFallbackUserAgents(2);
                    return;
                }
                
                try {
                    await getUpdatedUA('mb');
                } catch (mobileError) {
                    console.error('Failed to get updated mobile UA, using fallback:', mobileError);
                    await this._applyFallbackUserAgents(2);
                    return;
                }
            }
            
            // Validate UAs after update
            await this._validateUserAgents();
            
            notifyStableUAOutdated(flag);
        } catch (ex) {
            console.error('Error updating user agent:', ex);
            await this._applyFallbackUserAgents(flag);
        }
    }

    // Add validation method for user agents
    async _validateUserAgents() {
        console.log('Validating user agents after update');
        
        // Check PC user agent
        if (!userAgents.pc || typeof userAgents.pc !== 'string' || userAgents.pc.length < 20) {
            console.error('Invalid PC user agent after update:', userAgents.pc);
            await this._applyFallbackUserAgents(1);
        }
        
        // Check Mobile user agent
        if (!userAgents.mb || typeof userAgents.mb !== 'string' || userAgents.mb.length < 20) {
            console.error('Invalid Mobile user agent after update:', userAgents.mb);
            await this._applyFallbackUserAgents(2);
        }
    }

    // Add a new method to provide fallback user agents when updates fail
    async _applyFallbackUserAgents(flag) {
        console.log('Applying fallback user agents for flag:', flag);
        
        // Common fallback UAs that tend to work with Bing
        const fallbackUAs = {
            pc: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
            mb: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
        };
        
        // Initialize userAgents if not already done
        if (!userAgents) {
            userAgents = {
                pcSource: 'fallback',
                mbSource: 'fallback'
            };
        }
        
        if (flag === 1 || flag === 3) {
            userAgents.pc = fallbackUAs.pc;
            userAgents.pcSource = 'fallback';
            console.log('Applied fallback PC user agent:', userAgents.pc);
        }
        
        if (flag === 2 || flag === 3) {
            userAgents.mb = fallbackUAs.mb;
            userAgents.mbSource = 'fallback';
            console.log('Applied fallback Mobile user agent:', userAgents.mb);
        }
        
        // Store the fallback UAs to local storage for future use
        try {
            await chrome.storage.local.set({
                'fallbackPcUA': userAgents.pc,
                'fallbackMbUA': userAgents.mb,
                'lastFallbackUpdate': new Date().toISOString()
            });
            
            // Log the complete userAgents object for debugging
            console.log('Current user agents after applying fallbacks:', {
                pc: userAgents.pc,
                mb: userAgents.mb,
                pcSource: userAgents.pcSource,
                mbSource: userAgents.mbSource
            });
        } catch (err) {
            console.error('Failed to save fallback UAs to storage:', err);
        }
        
        // If this is a mobile UA issue, validate the user agent immediately after setting
        if (flag === 2 || flag === 3) {
            if (!userAgents.mb || typeof userAgents.mb !== 'string' || userAgents.mb.length < 20) {
                console.error('Fatal error: Mobile UA still invalid after fallback:', userAgents.mb);
                // Use a hardcoded UA as last resort
                userAgents.mb = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
                userAgents.mbSource = 'hardcoded';
                console.log('Using hardcoded mobile UA as last resort');
            }
        }
    }

    async _doPcSearch() {
        // Validate status before starting
        if (!this._status_ || !this._status_.pcSearchStatus) {
            console.error('Invalid status for PC search');
            return;
        }
        
        // Check if PC searches are already completed
        if (this._status_.pcSearchStatus.isCompleted) {
            console.log('PC searches already completed');
            return;
        }

        this._initiateSearch();
        if (this._currentSearchType_ != SEARCH_TYPE_PC_SEARCH) {
            this._preparePCSearch();
        }
        
        // Load any saved progress
        await this._loadSearchProgress();

        await this._requestBingSearch();
    }

    async _doMbSearch() {
        // Validate status before starting
        if (!this._status_ || !this._status_.mbSearchStatus) {
            console.error('Invalid status for mobile search');
            return;
        }
        
        // Check if mobile searches are already completed
        if (this._status_.mbSearchStatus.isCompleted) {
            console.log('Mobile searches already completed');
            return;
        }

        this._initiateSearch();
        if (this._currentSearchType_ != SEARCH_TYPE_MB_SEARCH) {
            this._prepareMbSearch();
        }
        
        // Load any saved progress
        await this._loadSearchProgress();

        await this._requestBingSearch();
    }

    async _initiateSearch() {
        this._currentSearchCount_ = 0;
        
        // Recalculate target count for the day - don't reuse existing one
        this._targetSearchCount = this._calculateSearchCount();
        
        // Calculate total search time
        const totalSearchTime = this._targetSearchCount * this._searchIntervalMS;
        const estimatedEndTime = new Date(Date.now() + totalSearchTime);
        
        // Store this in local storage so we can access it later if needed
        chrome.storage.local.set({
            'targetSearchCount': this._targetSearchCount,
            'searchIntervalMS': this._searchIntervalMS,
            'calculatedOn': new Date().toISOString()
        });
        
        const settings = await chrome.storage.sync.get({
            endTime: '17:00',
            enableSchedule: false
        });

        if (settings.enableSchedule) {
            const [endHour, endMinute] = settings.endTime.split(':').map(Number);
            const scheduleEnd = new Date();
            scheduleEnd.setHours(endHour, endMinute, 0);

            if (estimatedEndTime > scheduleEnd) {
                console.warn('Warning: Search session may extend past schedule:', {
                    searchCount: this._targetSearchCount,
                    totalMinutes: Math.floor(totalSearchTime / 60000),
                    estimatedEnd: estimatedEndTime.toLocaleTimeString(),
                    scheduleEnd: scheduleEnd.toLocaleTimeString()
                });
                
                // Optional: notify user
                chrome.notifications.create('schedule-warning', {
                    type: 'basic',
                    iconUrl: 'img/warn@8x.png',
                    title: 'Search Schedule Warning',
                    message: `Searches may continue past end time (${settings.endTime})`,
                    priority: 1
                });
            }
        }

        console.log(`Initiated ${this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ? 'PC' : 'Mobile'} search session:`, {
            target: this._targetSearchCount,
            estimatedEnd: estimatedEndTime.toLocaleTimeString(),
            intervalMs: this._searchIntervalMS
        });
    }

    _preparePCSearch() {
        this._currentSearchType_ = SEARCH_TYPE_PC_SEARCH;
        removeUA();
        setPCReqHeaders();
    }

    _prepareMbSearch() {
        this._currentSearchType_ = SEARCH_TYPE_MB_SEARCH;
        removeUA();
        try {
            // Validate mobile UA first
            if (!userAgents || !userAgents.mb || typeof userAgents.mb !== 'string' || userAgents.mb.length < 20) {
                console.error('Invalid mobile UA before setting headers:', userAgents?.mb);
                this._applyFallbackUserAgents(2).then(() => {
                    console.log('Applied fallback mobile UA before setting headers');
                }).catch(err => {
                    console.error('Failed to apply fallback mobile UA:', err);
                });
            }
            setMobileReqHeaders();
        } catch (err) {
            console.error('Error in prepareMbSearch:', err);
            // Try to recover by using fallback UA
            this._applyFallbackUserAgents(2);
            setMobileReqHeaders();
        }
    }

    _quitSearchCleanUp() {
        if (this._jobStatus_ == STATUS_BUSY) {
            this._jobStatus_ = STATUS_DONE;
        }
        this._currentSearchType_ = null;
        removeUA();
    }

    async _requestBingSearch() {
        // FIXED BUG: Always initialize the status if needed
        if (!this._currentSearchType_) {
            console.warn('Search type not initialized, defaulting to PC search');
            this._preparePCSearch();
        }
        
        try {
            // Check if searches are completed before continuing
            if (this._isCurrentSearchCompleted()) {
                console.log('Search completed check returned true, stopping search loop');
                return;
            }

            const searchType = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ? 'PC' : 'Mobile';
            let searchWord;
            
            // Maximum retries for a single search
            const MAX_RETRIES = 3;
            let retries = 0;
            let waitTime = 30000; // Start with 30 seconds between retries
            
            while (retries <= MAX_RETRIES) {
                try {
                    // Check internet connectivity first
                    const isConnected = await checkInternetConnectivity();
                    if (!isConnected) {
                        debugLog(`No internet connection for ${searchType} search, waiting...`, LOG_LEVELS.WARN);
                        
                        // Notify background script about connectivity issue - use Promise to handle async messaging properly
                        try {
                            await new Promise((resolve) => {
                                chrome.runtime.sendMessage(
                                    { action: 'connectivityIssue', searchType: searchType },
                                    (response) => {
                                        // Even if no response, still resolve
                                        resolve(response);
                                    }
                                );
                                // Ensure promise resolves even if no response
                                setTimeout(resolve, 1000);
                            });
                        } catch (msgErr) {
                            console.warn('Failed to send connectivity message:', msgErr);
                        }
                        
                        // Use a longer wait time for network issues - 2 minutes
                        await setTimeoutAsync(120000);
                        retries++;
                        continue;
                    }
                    
                    // Get word and cache it
                    searchWord = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ?
                        await this._googleTrend_.nextPCWord :
                        await this._googleTrend_.nextMBWord;
                        
                    console.log(`Performing ${searchType} search ${this._currentSearchCount_ + 1}: "${searchWord}"`);
                    
                    const response = await fetch(`https://www.bing.com/search?q=${searchWord}&form=QBRE`);
                    if (response.status != 200) {
                        throw new FetchResponseAnomalyException('Search');
                    }
                    
                    this._currentSearchCount_++;
                    
                    // Store timing info for popup display
                    const waitMs = this._searchIntervalMS;
                    const now = new Date();
                    this._searchStartTime = now;
                    this._nextSearchTime = new Date(now.getTime() + waitMs);
                    this._currentSearchTerm = searchWord; // Store the current search term
                    
                    console.log(`${searchType} search completed. Progress: ${this._currentSearchCount_}/${this._getCurrentMaxSearches()}`);
                    
                    // Store the successful search in local storage to track progress
                    await this._saveSearchProgress();
                    
                    // Enhanced timing log at INFO level
                    debugLog('Search timing:', {
                        currentTime: now.toLocaleTimeString(),
                        nextSearchAt: this._nextSearchTime.toLocaleTimeString(),
                        waitMinutes: Math.floor(waitMs/60000),
                        waitSeconds: Math.floor((waitMs % 60000)/1000),
                        remaining: this._getCurrentMaxSearches() - this._currentSearchCount_
                    }, LOG_LEVELS.INFO);

                    // Notify popup to refresh - use Promise to handle async messaging properly
                    try {
                        await new Promise((resolve, reject) => {
                            const messageTimeout = setTimeout(() => {
                                console.log('Message timeout reached, continuing search loop');
                                resolve({success: true, timedOut: true});
                            }, 3000);
                            
                            try {
                                chrome.runtime.sendMessage(
                                    {
                                        action: 'searchCompleted',
                                        content: {
                                            type: searchType,
                                            current: this._currentSearchCount_,
                                            total: this._getCurrentMaxSearches(),
                                            timestamp: Date.now()
                                        }
                                    },
                                    (response) => {
                                        clearTimeout(messageTimeout);
                                        // Even if no response, still resolve
                                        resolve(response || {success: true});
                                    }
                                );
                            } catch (err) {
                                clearTimeout(messageTimeout);
                                console.warn('Error sending search completion message:', err);
                                resolve({success: false, error: err.message});
                            }
                        });
                    } catch (msgErr) {
                        console.warn('Could not notify about search completion:', msgErr);
                        // Continue with search loop even if notification fails
                    }

                    // Wait for the search interval, but ensure it doesn't stall
                    try {
                        console.log(`Waiting ${waitMs}ms before next search`);
                        await Promise.race([
                            sleep(waitMs),
                            new Promise((resolve) => {
                                // Backup timeout to ensure we don't get stuck
                                setTimeout(() => {
                                    console.log('Backup timeout triggered to ensure search continues');
                                    resolve();
                                }, waitMs + 5000); // 5 seconds longer than intended wait
                            })
                        ]);
                        
                        // Double check search state is still valid
                        if (this._jobStatus_ !== STATUS_BUSY) {
                            console.log('Search job status changed during wait, stopping search loop');
                            return;
                        }
                        
                        // Logging to track search loop progression
                        console.log(`Wait complete, continuing to next search (${this._currentSearchCount_}/${this._getCurrentMaxSearches()})`);
                        
                        // Continue to next search with explicit try/catch to handle errors
                        try {
                            await this._requestBingSearch();
                        } catch (nextSearchErr) {
                            console.error('Error in next search iteration:', nextSearchErr);
                            // If there's an error in the next search, still allow the search loop to continue
                            // by calling _requestBingSearch again after a short delay if we're still not done
                            if (!this._isCurrentSearchCompleted() && this._jobStatus_ === STATUS_BUSY) {
                                console.log('Attempting to recover and continue search loop');
                                setTimeout(() => this._requestBingSearch(), 5000);
                            }
                        }
                    } catch (waitErr) {
                        console.error('Error during wait between searches:', waitErr);
                        // Try to continue the search loop even after wait errors
                        await this._requestBingSearch();
                    }
                    
                    return; // Successfully completed this search
                    
                } catch (ex) {
                    retries++;
                    const errorInfo = {
                        type: searchType,
                        term: searchWord,
                        error: ex,
                        attempt: retries,
                        maxRetries: MAX_RETRIES
                    };
                    
                    if (retries <= MAX_RETRIES) {
                        debugLog(`Search failed, will retry (${retries}/${MAX_RETRIES}):`, errorInfo, LOG_LEVELS.WARN);
                        
                        // On network errors, use exponential backoff with much longer delays
                        if (ex instanceof NetworkException || !navigator.onLine) {
                            waitTime = Math.min(waitTime * 2, 300000); // Cap at 5 minutes
                            debugLog(`Network error detected, increased wait time to ${waitTime/1000} seconds`, LOG_LEVELS.WARN);
                            
                            // Notify background about connectivity issue - use Promise to handle async messaging properly
                            try {
                                await new Promise((resolve) => {
                                    chrome.runtime.sendMessage(
                                        {
                                            action: 'connectivityIssue',
                                            searchType: searchType,
                                            error: ex.message
                                        },
                                        (response) => {
                                            // Even if no response, still resolve
                                            resolve(response);
                                        }
                                    );
                                    // Ensure promise resolves even if no response
                                    setTimeout(resolve, 1000);
                                });
                            } catch (msgErr) {
                                console.warn('Failed to send connectivity issue message:', msgErr);
                            }
                        }
                        
                        await setTimeoutAsync(waitTime);
                    } else {
                        console.error('Search failed after maximum retries:', errorInfo);
                        throw new FetchFailedException('Search', ex);
                    }
                }
            }
        } catch (outerError) {
            console.error('Critical error in _requestBingSearch:', outerError);
            
            // Try to recover from the error and continue searches if possible
            if (this._jobStatus_ === STATUS_BUSY && !this._isCurrentSearchCompleted()) {
                console.log('Attempting to recover from critical error and continue searches');
                
                // Wait a moment before trying to continue
                await sleep(5000);
                
                // Try to restart the search loop
                this._requestBingSearch().catch(err => {
                    console.error('Failed to restart search loop after error:', err);
                    // At this point, we've tried our best to recover
                });
            }
        }
    }

    async _saveSearchProgress() {
        const searchType = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ? 'pc' : 'mb';
        
        try {
            const data = await chrome.storage.local.get({
                pcSearchCount: 0,
                mbSearchCount: 0,
                lastSearchTime: null,
                dailyPointsEarned: 0
            });
            
            // Calculate points earned from this search
            const pointsPerSearch = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ? 5 : 5; // Assuming 5 points per search
            const searchPoints = pointsPerSearch;
            
            // Update the appropriate counter
            const updatedData = {
                lastSearchTime: Date.now(),
                dailyPointsEarned: data.dailyPointsEarned + searchPoints,
                searchesUpdatedOn: new Date().toISOString()
            };
            
            if (searchType === 'pc') {
                updatedData.pcSearchCount = this._currentSearchCount_;
            } else {
                updatedData.mbSearchCount = this._currentSearchCount_;
            }
            
            await chrome.storage.local.set(updatedData);
            debugLog(`Saved search progress: ${searchType} = ${this._currentSearchCount_} | Points: ${data.dailyPointsEarned + searchPoints}`, LOG_LEVELS.INFO);
        } catch (error) {
            console.error('Failed to save search progress:', error);
        }
    }

    async _loadSearchProgress() {
        try {
            // First check if we're on a new day compared to when searches were last updated
            const data = await chrome.storage.local.get({
                pcSearchCount: 0,
                mbSearchCount: 0,
                lastSearchTime: null,
                searchesUpdatedOn: null
            });
            
            // If we have search data from a previous session
            if (data.lastSearchTime) {
                const lastSearchDate = data.searchesUpdatedOn ? 
                    new Date(data.searchesUpdatedOn).toLocaleDateString() : 
                    new Date(data.lastSearchTime).toLocaleDateString();
                    
                const today = new Date().toLocaleDateString();
                
                // If the last recorded search was not from today, need to reset
                if (lastSearchDate !== today) {
                    debugLog(`Search data is from a different day (${lastSearchDate} vs ${today}). Resetting counts.`, LOG_LEVELS.INFO);
                    
                    // Reset counts for a new day
                    await chrome.storage.local.set({
                        pcSearchCount: 0,
                        mbSearchCount: 0,
                        lastSearchTime: null,
                        searchesUpdatedOn: new Date().toISOString()
                    });
                    
                    this._currentSearchCount_ = 0;
                    return;
                }
                
                // If search data is from today, load it
                if (this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH) {
                    this._currentSearchCount_ = data.pcSearchCount;
                } else {
                    this._currentSearchCount_ = data.mbSearchCount;
                }
                
                debugLog(`Loaded saved search progress from today: ${this._currentSearchCount_}`, LOG_LEVELS.INFO);
            } else {
                debugLog('No saved search progress found', LOG_LEVELS.DEBUG);
            }
        } catch (error) {
            console.error('Failed to load search progress:', error);
        }
    }

    async _loadSearchSettings() {
        // Check if we already have settings stored for today
        const today = new Date().toLocaleDateString();
        const data = await chrome.storage.local.get({
            'targetSearchCount': null,
            'searchIntervalMS': null,
            'calculatedOn': null
        });
        
        // If we have valid cached settings from today, use those
        if (data.calculatedOn && new Date(data.calculatedOn).toLocaleDateString() === today &&
            data.targetSearchCount !== null && data.searchIntervalMS !== null) {
            
            console.log('Using cached search settings from today:', {
                targetCount: data.targetSearchCount,
                intervalMS: data.searchIntervalMS
            });
            
            this._targetSearchCount = data.targetSearchCount;
            this._searchIntervalMS = data.searchIntervalMS;
            
            // Still load base settings in case we need them
        }
        
        const settings = await chrome.storage.sync.get({
            baseSearchCount: 30,
            searchVariation: 5,
            baseSearchInterval: 15,
            intervalVariation: 300
        });
        
        this._baseSearchCount = settings.baseSearchCount;
        this._searchVariation = settings.searchVariation;
        
        // Only calculate new interval if we don't have a valid one from today
        if (!data.searchIntervalMS || new Date(data.calculatedOn).toLocaleDateString() !== today) {
            // Calculate search interval with randomization
            const baseMs = settings.baseSearchInterval * 60 * 1000;
            const randomFactor = Math.random() - 0.5; // -0.5 to 0.5
            const variationMs = randomFactor * settings.intervalVariation * 2 * 1000;
            this._searchIntervalMS = Math.max(30000, baseMs + variationMs); // Minimum 30 seconds
            
            debugLog('Fresh search timing calculated:', {
                baseMinutes: settings.baseSearchInterval,
                variationSeconds: settings.intervalVariation,
                finalSeconds: Math.floor(this._searchIntervalMS / 1000),
                randomFactor: randomFactor.toFixed(3)
            }, LOG_LEVELS.INFO);
        }

        return this._getCurrentMaxSearches();
    }

    _calculateSearchCount() {
        // Ensure we have base count and status before calculating
        if (!this._baseSearchCount || !this._status_) {
            console.log('Using default search count - settings or status not ready');
            return 30; // Default count if not configured
        }

        // Get random number between 0 and 1
        const randomFactor = Math.random();
        const variation = (randomFactor - 0.5) * 2 * this._searchVariation;
        const searchCount = Math.round(this._baseSearchCount + variation);
        
        console.log(`Search count calculation:`, {
            base: this._baseSearchCount,
            variation: this._searchVariation,
            random: randomFactor.toFixed(3),
            final: searchCount
        });
        
        return searchCount;
    }

    _getCurrentMaxSearches() {
        // Use stored count or fall back to safe default
        if (!this._status_) {
            console.warn('Status not initialized, using default search count');
            return this._targetSearchCount ?? 30;
        }

        return this._targetSearchCount ?? 
            (this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ? 
                this._status_.pcSearchStatus.searchNeededCount : 
                this._status_.mbSearchStatus.searchNeededCount);
    }

    _getBingSearchUrl() {
        const word = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ?
            this._googleTrend_.nextPCWord :
            this._googleTrend_.nextMBWord;

        return `https://www.bing.com/search?q=${word}&form=QBRE`;
    }

    _isCurrentSearchCompleted() {
        if (!this._status_ || !this._currentSearchType_) {
            console.warn('Cannot check completion - status or search type not initialized');
            return false; // IMPORTANT FIX: Return false instead of true when not initialized
        }

        const type = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ? 'PC' : 'Mobile';
        const status = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ? 
            this._status_.pcSearchStatus : 
            this._status_.mbSearchStatus;
            
        // First check if the search type is already marked as completed
        if (status.isCompleted) {
            console.log(`${type} searches already completed according to status`);
            return true;
        }

        // Check against required search count
        const currentProgress = this._currentSearchCount_;
        
        // Add additional logging to track the values being used
        console.log(`Search completion check details:`, {
            currentProgress: currentProgress,
            statusProgress: status.progress,
            statusNeededCount: status.searchNeededCount,
            statusMaxCount: status.progressMax,
            calculatedTarget: this._targetSearchCount
        });

        // Make sure we're using the correct search count - get it directly from status
        const neededCount = Math.max(
            status.searchNeededCount || 0, 
            this._targetSearchCount || 0
        );
        
        // If both values are 0 or undefined, use a reasonable default
        if (!neededCount) {
            console.warn(`${type} search needed count is invalid (${neededCount}), using default target`);
            const defaultTarget = type === 'PC' ? 30 : 20;
            const isComplete = currentProgress >= defaultTarget;
            
            console.log(`${type} search completion using default (${defaultTarget}):`, {
                current: currentProgress,
                needed: defaultTarget,
                isComplete: isComplete
            });
            
            return isComplete;
        }

        const isComplete = currentProgress >= neededCount;

        console.log(`${type} search completion check:`, {
            current: currentProgress,
            needed: neededCount,
            isComplete: isComplete,
            statusValid: status.isValid
        });

        return isComplete;
    }

    getSearchProgress() {
        if (this._searchStartTime && this._nextSearchTime) {
            const now = new Date();
            const totalInterval = this._searchIntervalMS;
            const timeElapsed = now - this._searchStartTime;
            const timeRemaining = Math.max(0, this._nextSearchTime - now);
            
            // Calculate percent completion of current interval
            const percentComplete = Math.min(100, Math.floor((timeElapsed / totalInterval) * 100));
            
            // Get the next search term that will be used
            let nextSearchTerm;
            try {
                nextSearchTerm = this._googleTrend_ ? this._googleTrend_.getNextTermForDisplay() : '[next term]';
            } catch (err) {
                console.warn('Error getting next search term:', err);
                nextSearchTerm = '[next term]';
            }
            
            const progress = {
                inProgress: true,
                type: this._currentSearchType_ === SEARCH_TYPE_PC_SEARCH ? 'PC' : 'Mobile',
                current: this._currentSearchCount_,
                total: this._getCurrentMaxSearches(),
                nextSearchTime: this._nextSearchTime.toLocaleTimeString(),
                timeRemaining: timeRemaining,
                searchInterval: totalInterval,
                percentComplete: percentComplete,
                searchTerm: this._currentSearchTerm || '[searching...]',
                nextSearchTerm: nextSearchTerm,
                
                // Add additional timing details
                elapsedMs: timeElapsed,
                totalIntervalMs: totalInterval,
                
                // Add search state information
                isPaused: this._pausedBySchedule || false,
                searchState: this._jobStatus_
            };
            
            console.log('Search progress:', progress);
            return progress;
        }
        
        return {
            inProgress: false
        };
    }

    // Add method to get the next search term
    _getNextSearchTerm() {
        try {
            if (!this._googleTrend_) {
                console.warn('Google trends not available');
                return '[next term]';
            }
            
            // Use the new non-async method that doesn't consume terms
            return this._googleTrend_.getNextTermForDisplay();
        } catch (error) {
            console.error('Failed to get next search term:', error);
            return '[next term]';
        }
    }

    // Add method to skip the current search
    async skipCurrentSearch() {
        console.log('Skipping current search');
        
        if (!this._searchStartTime || !this._nextSearchTime) {
            console.log('No active search to skip');
            return false;
        }
        
        try {
            // Force the GoogleTrend object to select a new next term
            // This is the key fix - we need to reset the cached term
            if (this._googleTrend_) {
                // Clear the cached term to force selection of a new one
                this._googleTrend_._cachedNextTerm = null;
                // Force an update of the cached term with a new random term
                await this._googleTrend_._updateCachedNextTerm();
                console.log('Forced new search term selection after skip');
            }
            
            // Get the current time to calculate elapsed time since last search
            const now = new Date();
            const elapsedSinceLastSearch = now - this._searchStartTime;
            
            // Enforce a minimum delay between searches to prevent rate limiting
            // This is crucial to avoid exhausting the search list too quickly
            const MINIMUM_DELAY_MS = 10000; // 10 seconds minimum between searches
            
            if (elapsedSinceLastSearch < MINIMUM_DELAY_MS) {
                const waitTime = MINIMUM_DELAY_MS - elapsedSinceLastSearch;
                console.log(`Enforcing minimum delay of ${waitTime}ms before next search to prevent rate limiting`);
                
                // Show notification about enforced delay
                this._nextSearchTime = new Date(now.getTime() + waitTime);
                
                // Notify UI about the wait
                try {
                    chrome.runtime.sendMessage({
                        action: 'searchDelayed',
                        content: {
                            waitTimeMs: waitTime,
                            nextSearchTime: this._nextSearchTime.toLocaleTimeString()
                        }
                    });
                } catch (err) {
                    console.warn('Failed to send search delay notification:', err);
                }
                
                // Wait the minimum time before allowing the next search
                await sleep(waitTime);
            } else {
                // Skip the current wait and proceed to the next search immediately
                // but still update the next search time for normal scheduling
                this._nextSearchTime = new Date();
            }
            
            // Log the skip
            debugLog('Manually skipped to next search', LOG_LEVELS.INFO);
            
            // Notify about the skip via message to ensure UI is updated
            // Use a different action to distinguish from regular completion
            await new Promise((resolve) => {
                try {
                    chrome.runtime.sendMessage(
                        {
                            action: 'searchSkipped',
                            content: {
                                type: this._currentSearchType_ === SEARCH_TYPE_PC_SEARCH ? 'PC' : 'Mobile',
                                current: this._currentSearchCount_,
                                total: this._getCurrentMaxSearches(),
                                timestamp: Date.now(),
                                nextTerm: this._googleTrend_.getNextTermForDisplay() // Include the new term
                            }
                        },
                        (response) => {
                            // Even if no response, still resolve
                            resolve(response || { success: true });
                        }
                    );
                    // Ensure promise resolves even if no response
                    setTimeout(resolve, 1000);
                } catch (err) {
                    console.warn('Failed to send search skipped message:', err);
                    resolve({ success: false });
                }
            });
            
            // Return true to indicate successful skip
            return true;
        } catch (error) {
            console.error('Error skipping search:', error);
            // Return true anyway since we did update the next search time
            return true;
        }
    }

    // Add method to force stop search activities (for scheduling)
    async forceStop() {
        console.log('Force stopping search quest due to schedule pause');
        
        // Store current progress before stopping
        try {
            await this._saveSearchProgress();
        } catch (error) {
            console.error('Error saving progress during force stop:', error);
        }
        
        // Mark as done so the search loop will exit
        this._jobStatus_ = STATUS_DONE;
        
        // Clear search type and timers to prevent further searches
        this._currentSearchType_ = null;
        this._nextSearchTime = null;
        
        // Save pause timestamp and reason
        chrome.storage.local.set({
            'searchPausedAt': new Date().toISOString(),
            'pausedSearchCount': this._currentSearchCount_,
            'pausedSearchType': this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ? 'pc' : 'mb',
            'searchPausedReason': 'scheduleEnd'
        });
        
        // Set flag to indicate this was paused by schedule
        this._pausedBySchedule = true;
        
        console.log('Search quest successfully paused');
        return true;
    }
}

function removeUA() {
    // Updated for Manifest V3
    debugLog('Removing UA headers');
}

function setPCReqHeaders() {
    // Updated for Manifest V3
    debugLog('Setting PC headers:', userAgents.pc);
    chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [1],
        addRules: [{
            "id": 1,
            "priority": 1,
            "action": {
                "type": "modifyHeaders",
                "requestHeaders": [
                    { "header": "User-Agent", "operation": "set", "value": userAgents.pc }
                ]
            },
            "condition": {
                "urlFilter": "bing.com/search",
                "resourceTypes": ["main_frame"]
            }
        }]
    });
}

function setMobileReqHeaders() {
    // Updated for Manifest V3
    debugLog('Setting mobile headers:', userAgents.mb);
    chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [1],
        addRules: [{
            "id": 1,
            "priority": 1,
            "action": {
                "type": "modifyHeaders",
                "requestHeaders": [
                    { "header": "User-Agent", "operation": "set", "value": userAgents.mb }
                ]
            },
            "condition": {
                "urlFilter": "bing.com/search",
                "resourceTypes": ["main_frame"]
            }
        }]
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function notifyStableUAOutdated(flag) {
    if (developer && developer.notification_ua_stable_outdated) {
        const message = 'Stable UA is outdated! Flag: ' + (flag == 3 ? 'pc and mobile' : flag == 1 ? 'pc' : 'mobile');
        console.log(message);
        chrome.notifications.clear('stable_ua_outdated');
        chrome.notifications.create('stable_ua_outdated', {
            type: 'basic',
            iconUrl: 'img/warn@8x.png',
            title: 'Developer notification',
            message: message,
            priority: 2,
        });
    }
}

function notifyUpdatedUAOutdated() {
    if (developer && developer.notification_ua_updated_outdated) {
        const message = 'Critical!! Updated UA is outdated!';
        console.log(message);
        chrome.notifications.clear('updated_ua_outdated');
        chrome.notifications.create('updated_ua_outdated', {
            type: 'basic',
            iconUrl: 'img/err@8x.png',
            title: 'Developer notification',
            message: message,
            priority: 2,
        });
    }
}
