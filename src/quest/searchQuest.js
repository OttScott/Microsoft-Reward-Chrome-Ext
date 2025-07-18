class SearchQuest {
    constructor(googleTrend) {
        this._googleTrend_ = googleTrend;
        this.reset();
        this._loadSearchSettings();
        this._targetSearchCount = null;
        this._nextSearchTime = null;
        this._searchStartTime = null;
        this._initializationAttempts = 0;
        
        // Throttling properties for log spam prevention
        this._lastSearchTypeWarning = 0;
        this._lastProgressAnomaly = 0;
        this._lastTargetCountLog = 0;
    }

    reset() {
        this._status_ = null;
        this._pcSearchWordIdx_ = 0;
        this._mbSearchWordIdx_ = 0;
        this._currentSearchCount_ = 0;
        this._currentSearchType_ = null;
        this._jobStatus_ = STATUS_NONE;
        this._targetSearchCount = null; // Clear target count to force recalculation
        this._pausedBySchedule = false; // Clear pause flag on reset
        this._manuallyPaused = false; // Clear manual pause flag on reset
        this._forceStopped = false; // Clear force stop flag on reset
        
        // When resetting, recalculate search interval for variety
        this._loadSearchSettings().then(() => {
            console.log('Search settings reloaded during reset with new randomization');
        }).catch(err => {
            console.error('Failed to reload search settings during reset:', err);
        });
    }

    /**
     * Resume searches that were paused by schedule
     */
    resume() {
        console.log('Resuming SearchQuest from scheduled pause');
        
        // Clear the pause flag
        this._pausedBySchedule = false;
        
        // If the job status is DONE due to pause, reset it to allow new work
        if (this._jobStatus_ === STATUS_DONE) {
            console.log('Resetting job status from DONE to NONE to allow resume');
            this._jobStatus_ = STATUS_NONE;
        }
        
        // Clear timing-related fields that might interfere with restart
        this._searchStartTime = null;
        this._nextSearchTime = null;
        this._currentSearchTerm = null;
        
        console.log('SearchQuest resume completed');
    }

    get jobStatus() {
        // If manually stopped or force stopped, return STATUS_DONE
        if (this._manuallyPaused || this._forceStopped) {
            return STATUS_DONE;
        }
        return this._jobStatus_;
    }

    async doWork(status) {
        console.assert(status != null);
        console.log('SearchQuest.doWork() starting with status:', {
            isValid: status.summary?.isValid,
            pcCompleted: status.pcSearchStatus?.isCompleted,
            mbCompleted: status.mbSearchStatus?.isCompleted
        });
        
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
        console.log('SearchQuest status set to BUSY, starting work...');
        
        try {
            await getUA();
            await this._googleTrend_.getGoogleTrendWords();
            await this._doWorkLoop();
            
            console.log('SearchQuest.doWork() completed successfully');
        } catch (ex) {
            console.error('SearchQuest.doWork() failed with error:', ex);
            this._jobStatus_ = STATUS_ERROR;
            if (ex instanceof UserAgentInvalidException) {
                notifyUpdatedUAOutdated();
            }
            throw ex;
        }
    }

    async _doWorkLoop() {
        // Simplified work loop - no more infinite loop guards
        console.log('Starting search work loop');
        
        try {
            // Check if all searches are already completed
            if (this._status_.pcSearchStatus.isCompleted && 
                (this._status_.mbSearchStatus.isCompleted || this._status_.mbSearchStatus.isValid === false)) {
                console.log('All searches already completed');
                this._jobStatus_ = STATUS_DONE;
                return;
            }

            // Check for invalid status
            if (this._status_.jobStatus == STATUS_ERROR || !this._status_.summary.isValid) {
                console.log('Invalid status detected, stopping work loop');
                this._jobStatus_ = STATUS_ERROR;
                return;
            }

            // Execute search quests once
            await this._startSearchQuests();
            
            // Check if searches were successful
            const flag = await this.isSearchSuccessful();
            if (flag > 0) {
                console.log('Search success check failed, getting alternative UA');
                await this._getAlternativeUA(flag);
            }
            
            console.log('Work loop completed successfully');
            
        } catch (error) {
            console.error('Error in search work loop:', error);
            this._jobStatus_ = STATUS_ERROR;
        }
    }

    async _startSearchQuests() {
        console.log('_startSearchQuests() starting...');
        
        // Check if searches are already completed before starting
        if (this._status_.pcSearchStatus.isCompleted && 
            (this._status_.mbSearchStatus.isCompleted || this._status_.mbSearchStatus.isValid === false)) {
            console.log('All searches already completed, skipping search quests');
            this._jobStatus_ = STATUS_DONE;
            return;
        }

        // Get search behavior settings
        const settings = await chrome.storage.sync.get({ 
            disableMobile: false,
            interleaveSearches: false,
            smartSwitching: true
        });

        // Determine search strategy
        if (settings.interleaveSearches) {
            console.log('Using interleaved search strategy...');
            await this._doInterleavedSearches(settings);
        } else if (settings.smartSwitching) {
            console.log('Using smart switching search strategy...');
            await this._doSmartSearches(settings);
        } else {
            console.log('Using traditional sequential search strategy...');
            await this._doSequentialSearches(settings);
        }
        
        console.log('_startSearchQuests() search strategies completed, checking for cleanup...');
        
        // Add a small delay to ensure any async operations complete
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Only cleanup if no searches are currently running
        if (this._jobStatus_ !== STATUS_BUSY) {
            console.log('Safe to cleanup - no searches running');
            this._quitSearchCleanUp();
        } else {
            console.log('Searches still running, deferring cleanup');
            // The individual search functions will handle their own cleanup
        }
    }

    async _doSequentialSearches(settings) {
        // Original behavior: PC first, then mobile
        if (!this._status_.pcSearchStatus.isCompleted) {
            console.log('Starting PC searches...');
            await this._doPcSearch();
            console.log('PC searches completed or stopped');
        } else {
            console.log('PC searches already completed, skipping');
        }
        
        if (!settings.disableMobile && !this._status_.mbSearchStatus.isCompleted) {
            console.log('Starting mobile searches...');
            await this._doMbSearch();
            console.log('Mobile searches completed or stopped');
        } else {
            console.log('Mobile searches disabled in settings or already completed');
        }
    }

    async _doSmartSearches(settings) {
        // Smart switching: Check which search type can still earn points and do them in priority order
        let pcCanEarnPoints = !this._status_.pcSearchStatus.isCompleted && this._canEarnMorePoints('pc');
        let mbCanEarnPoints = !settings.disableMobile && !this._status_.mbSearchStatus.isCompleted && this._canEarnMorePoints('mb');
        
        console.log('Smart search analysis:', {
            pcCanEarn: pcCanEarnPoints,
            mbCanEarn: mbCanEarnPoints,
            pcCompleted: this._status_.pcSearchStatus.isCompleted,
            mbCompleted: this._status_.mbSearchStatus.isCompleted
        });

        // Continue searching until both are done or can't earn points
        while ((pcCanEarnPoints || mbCanEarnPoints) && this._jobStatus_ === STATUS_BUSY) {
            // If PC is maxed out but mobile isn't, do mobile
            if (!pcCanEarnPoints && mbCanEarnPoints) {
                console.log('PC searches maxed out, switching to mobile searches...');
                await this._doMbSearch();
            }
            // If mobile is maxed out but PC isn't, do PC  
            else if (pcCanEarnPoints && !mbCanEarnPoints) {
                console.log('Mobile searches maxed out, switching to PC searches...');
                await this._doPcSearch();
            }
            // If both can earn points, prioritize PC first (traditional order)
            else if (pcCanEarnPoints && mbCanEarnPoints) {
                console.log('Both search types can earn points, doing PC searches first...');
                await this._doPcSearch();
                
                // After PC completes, check if we should do mobile
                // Re-evaluate the status in case something changed
                console.log('PC search completed, updating status before checking mobile...');
                await this._status_.update();
                
                // Debug: Check status after update
                console.log('Status after PC completion and update:', {
                    pcCompleted: this._status_.pcSearchStatus.isCompleted,
                    pcProgress: this._status_.pcSearchStatus.progress,
                    pcProgressMax: this._status_.pcSearchStatus.progressMax,
                    mbCompleted: this._status_.mbSearchStatus.isCompleted,
                    mbProgress: this._status_.mbSearchStatus.progress,
                    mbProgressMax: this._status_.mbSearchStatus.progressMax,
                    jobStatus: this._jobStatus_
                });
                
                mbCanEarnPoints = !settings.disableMobile && !this._status_.mbSearchStatus.isCompleted && this._canEarnMorePoints('mb');
                
                console.log('Mobile evaluation after PC:', {
                    disableMobile: settings.disableMobile,
                    mbCompleted: this._status_.mbSearchStatus.isCompleted,
                    canEarnMorePoints: this._canEarnMorePoints('mb'),
                    mbCanEarnPoints: mbCanEarnPoints,
                    jobStatus: this._jobStatus_
                });
                
                if (mbCanEarnPoints && this._jobStatus_ === STATUS_BUSY) {
                    console.log('PC completed, now doing mobile searches...');
                    await this._doMbSearch();
                } else {
                    console.log('Not transitioning to mobile searches:', {
                        mbCanEarnPoints: mbCanEarnPoints,
                        jobStatus: this._jobStatus_
                    });
                }
            }
            
            // Re-evaluate what's still needed after each completion
            await this._status_.update();
            pcCanEarnPoints = !this._status_.pcSearchStatus.isCompleted && this._canEarnMorePoints('pc');
            mbCanEarnPoints = !settings.disableMobile && !this._status_.mbSearchStatus.isCompleted && this._canEarnMorePoints('mb');
            
            console.log('Re-evaluated search needs:', {
                pcCanEarn: pcCanEarnPoints,
                mbCanEarn: mbCanEarnPoints,
                jobStatus: this._jobStatus_
            });
            
            // Safety check to prevent infinite loops
            if (!pcCanEarnPoints && !mbCanEarnPoints) {
                console.log('No more search types can earn additional points today');
                break;
            }
        }
        
        console.log('Smart search strategy completed');
    }

    async _doInterleavedSearches(settings) {
        // Interleaved approach: alternate between PC and mobile searches
        const pcNeeded = !this._status_.pcSearchStatus.isCompleted;
        const mbNeeded = !settings.disableMobile && !this._status_.mbSearchStatus.isCompleted;
        
        if (!pcNeeded && !mbNeeded) {
            console.log('No searches needed');
            return;
        }

        console.log('Starting interleaved search session...');
        
        // Determine which search types we'll be doing
        const searchTypes = [];
        if (pcNeeded) searchTypes.push('pc');
        if (mbNeeded) searchTypes.push('mb');
        
        // If only one type needed, just do that one
        if (searchTypes.length === 1) {
            if (searchTypes[0] === 'pc') {
                await this._doPcSearch();
            } else {
                await this._doMbSearch();
            }
            return;
        }

        // Interleave the searches
        let currentTypeIndex = 0;
        const maxIterations = 100; // Safety limit
        let iterations = 0;
        
        while ((pcNeeded && !this._status_.pcSearchStatus.isCompleted) || 
               (mbNeeded && !this._status_.mbSearchStatus.isCompleted)) {
            
            if (iterations++ > maxIterations) {
                console.warn('Interleaved search safety limit reached');
                break;
            }
            
            const currentSearchType = searchTypes[currentTypeIndex % searchTypes.length];
            
            // Generate random batch size between 3-8 searches for variety
            const batchSize = Math.floor(Math.random() * 6) + 3; // Random between 3-8
            
            if (currentSearchType === 'pc' && !this._status_.pcSearchStatus.isCompleted) {
                console.log(`Interleaved search: Performing PC search batch (${batchSize} searches)...`);
                await this._doLimitedPcSearch(batchSize);
            } else if (currentSearchType === 'mb' && !this._status_.mbSearchStatus.isCompleted) {
                console.log(`Interleaved search: Performing mobile search batch (${batchSize} searches)...`);
                await this._doLimitedMbSearch(batchSize);
            }
            
            // Update status to check completion
            try {
                await this._status_.update();
            } catch (error) {
                console.error('Error updating status during interleaved search:', error);
            }
            
            currentTypeIndex++;
        }
        
        console.log('Interleaved search session completed');
    }

    _canEarnMorePoints(searchType) {
        // Check if this search type can still earn points based on daily limits
        try {
            if (searchType === 'pc') {
                const status = this._status_.pcSearchStatus;
                console.log(`PC point earning check:`, {
                    progress: status.progress,
                    progressMax: status.progressMax,
                    isCompleted: status.isCompleted,
                    canEarnMore: status.progress < status.progressMax && !status.isCompleted
                });
                // Consider maxed if progress equals or exceeds the progress max (daily point limit)
                return status.progress < status.progressMax && !status.isCompleted;
            } else if (searchType === 'mb') {
                const status = this._status_.mbSearchStatus;
                console.log(`Mobile point earning check:`, {
                    progress: status.progress,
                    progressMax: status.progressMax,
                    isCompleted: status.isCompleted,
                    canEarnMore: status.progress < status.progressMax && !status.isCompleted
                });
                return status.progress < status.progressMax && !status.isCompleted;
            }
        } catch (error) {
            console.warn('Error checking point earning potential:', error);
            // If we can't determine, assume we can still earn points
            return true;
        }
        return true;
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
        
        // Enhanced fallback UAs with more recent and varied mobile user agents
        // These are designed to better mimic real mobile app behavior
        const fallbackUAs = {
            pc: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
            mb: [
                // iOS Safari (latest versions)
                'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
                'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
                // Microsoft Edge Mobile (tends to work better with Bing)
                'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/119.0.2151.96 Mobile/15E148 Safari/605.1.15',
                'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.193 Mobile Safari/537.36 EdgA/119.0.2151.78',
                // Chrome Mobile
                'Mozilla/5.0 (Linux; Android 13; Pixel 7 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.193 Mobile Safari/537.36',
                'Mozilla/5.0 (Linux; Android 14; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.193 Mobile Safari/537.36'
            ]
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
            // Randomly select a mobile UA to vary behavior and avoid detection
            const mobileUAs = fallbackUAs.mb;
            userAgents.mb = mobileUAs[Math.floor(Math.random() * mobileUAs.length)];
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

    // Build mobile-optimized search URL
    _buildSearchUrl(searchWord, searchType) {
        const encodedQuery = encodeURIComponent(searchWord);
        
        if (searchType === 'Mobile') {
            // Use mobile-specific parameters that Bing mobile app typically uses
            return `https://www.bing.com/search?q=${encodedQuery}&form=QBREMB&sc=8-0&sp=-1&pq=${encodedQuery}&cvid=${this._generateRandomCvid()}`;
        } else {
            // Keep standard PC search URL
            return `https://www.bing.com/search?q=${encodedQuery}&form=QBRE`;
        }
    }

    // Build mobile-specific headers to better mimic mobile app behavior
    _buildSearchHeaders(searchType) {
        const headers = {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        };

        if (searchType === 'Mobile') {
            // Add mobile-specific headers
            headers['Accept-Encoding'] = 'gzip, deflate, br';
            headers['Sec-Fetch-Dest'] = 'document';
            headers['Sec-Fetch-Mode'] = 'navigate';
            headers['Sec-Fetch-Site'] = 'none';
            headers['Sec-Fetch-User'] = '?1';
            headers['Upgrade-Insecure-Requests'] = '1';
            // Add mobile viewport indicator
            headers['Viewport-Width'] = '375';
        }

        return headers;
    }

    // Generate random CVID for mobile searches (mimics Bing mobile app behavior)
    _generateRandomCvid() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < 32; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    // Add mobile-specific delays to better mimic human mobile usage patterns
    async _getMobileSearchDelay() {
        // Mobile users typically have slightly longer delays between searches
        // due to touch interface and screen transitions
        const baseDelay = 15000; // 15 seconds base
        const randomVariation = Math.random() * 10000; // 0-10 seconds additional
        return Math.floor(baseDelay + randomVariation);
    }

    async _doPcSearch() {
        console.log('_doPcSearch() starting...');
        
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

        console.log('Initiating PC search session...');
        this._initiateSearch();
        if (this._currentSearchType_ != SEARCH_TYPE_PC_SEARCH) {
            this._preparePCSearch();
        }
        
        // Load any saved progress
        await this._loadSearchProgress();
        console.log(`PC search starting with ${this._currentSearchCount_} searches already completed`);

        await this._requestBingSearch();
        
        // Update status after PC search completion
        try {
            console.log('Updating status after PC search completion');
            await this._status_.update();
        } catch (error) {
            console.error('Failed to update status after PC search:', error);
        }
        
        console.log('_doPcSearch() completed');
        
        // Debug: Log PC completion state
        if (this._status_ && this._status_.pcSearchStatus) {
            console.log('PC search completion status:', {
                isCompleted: this._status_.pcSearchStatus.isCompleted,
                progress: this._status_.pcSearchStatus.progress,
                progressMax: this._status_.pcSearchStatus.progressMax,
                searchNeededCount: this._status_.pcSearchStatus.searchNeededCount,
                currentSearchCount: this._currentSearchCount_
            });
        }
    }

    async _doMbSearch() {
        console.log('_doMbSearch() starting...');
        
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

        console.log('Initiating mobile search session...');
        this._initiateSearch();
        if (this._currentSearchType_ != SEARCH_TYPE_MB_SEARCH) {
            this._prepareMbSearch();
        }
        
        // Load any saved progress
        await this._loadSearchProgress();
        console.log(`Mobile search starting with ${this._currentSearchCount_} searches already completed`);

        await this._requestBingSearch();
        
        // Update status after mobile search completion
        try {
            console.log('Updating status after mobile search completion');
            await this._status_.update();
        } catch (error) {
            console.error('Failed to update status after mobile search:', error);
        }
        
        console.log('_doMbSearch() completed');
    }

    async _doLimitedPcSearch(maxSearches) {
        console.log(`_doLimitedPcSearch() starting with limit of ${maxSearches}...`);
        
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

        console.log('Initiating limited PC search session...');
        this._initiateSearch();
        if (this._currentSearchType_ != SEARCH_TYPE_PC_SEARCH) {
            this._preparePCSearch();
        }
        
        // Load any saved progress
        await this._loadSearchProgress();
        const startingCount = this._currentSearchCount_;
        console.log(`Limited PC search starting with ${this._currentSearchCount_} searches already completed`);

        await this._requestLimitedBingSearch(maxSearches);
        
        // Update status after limited PC search completion
        try {
            console.log('Updating status after limited PC search completion');
            await this._status_.update();
        } catch (error) {
            console.error('Failed to update status after limited PC search:', error);
        }
        
        const searchesPerformed = this._currentSearchCount_ - startingCount;
        console.log(`_doLimitedPcSearch() completed - performed ${searchesPerformed} searches`);
    }

    async _doLimitedMbSearch(maxSearches) {
        console.log(`_doLimitedMbSearch() starting with limit of ${maxSearches}...`);
        
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

        console.log('Initiating limited mobile search session...');
        this._initiateSearch();
        if (this._currentSearchType_ != SEARCH_TYPE_MB_SEARCH) {
            this._prepareMbSearch();
        }
        
        // Load any saved progress
        await this._loadSearchProgress();
        const startingCount = this._currentSearchCount_;
        console.log(`Limited mobile search starting with ${this._currentSearchCount_} searches already completed`);

        await this._requestLimitedBingSearch(maxSearches);
        
        // Update status after limited mobile search completion
        try {
            console.log('Updating status after limited mobile search completion');
            await this._status_.update();
        } catch (error) {
            console.error('Failed to update status after limited mobile search:', error);
        }
        
        const searchesPerformed = this._currentSearchCount_ - startingCount;
        console.log(`_doLimitedMbSearch() completed - performed ${searchesPerformed} searches`);
    }

    async _initiateSearch() {
        this._currentSearchCount_ = 0;
        
        // Recalculate target count for the day - don't reuse existing one
        this._targetSearchCount = this._calculateSearchCount();
        
        // Calculate total search time
        const totalSearchTime = this._targetSearchCount * this._searchIntervalMS;
        const estimatedEndTime = new Date(Date.now() + totalSearchTime);
        
        // Create settings hash for cache validation
        const settingsHash = JSON.stringify({
            baseSearchCount: this._baseSearchCount,
            searchVariation: this._searchVariation,
            baseSearchInterval: Math.floor(this._searchIntervalMS / 60000), // Convert back to minutes for hash
            intervalVariation: 300 // Default variation for hash consistency
        });
        
        // Store this in local storage so we can access it later if needed
        chrome.storage.local.set({
            'targetSearchCount': this._targetSearchCount,
            'searchIntervalMS': this._searchIntervalMS,
            'calculatedOn': new Date().toISOString(),
            'settingsHash': settingsHash
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
        console.log('_quitSearchCleanUp() called, current status:', this._jobStatus_);
        
        // Only set to DONE if searches are truly finished and we were busy
        if (this._jobStatus_ == STATUS_BUSY) {
            // Check if we actually completed searches or just stopped for some reason
            const pcCompleted = !this._status_?.pcSearchStatus || this._status_.pcSearchStatus.isCompleted;
            const mbCompleted = !this._status_?.mbSearchStatus || this._status_.mbSearchStatus.isCompleted || this._status_.mbSearchStatus.isValid === false;
            
            if (pcCompleted && mbCompleted) {
                console.log('All required searches completed, setting status to DONE');
                this._jobStatus_ = STATUS_DONE;
            } else {
                console.log('Searches not fully completed:', {
                    pcCompleted: pcCompleted,
                    mbCompleted: mbCompleted,
                    pcStatus: this._status_?.pcSearchStatus?.isCompleted,
                    mbStatus: this._status_?.mbSearchStatus?.isCompleted
                });
                this._jobStatus_ = STATUS_DONE; // Still set to done to prevent hanging
            }
        }
        
        // Only clear search type if we're truly done or in error state
        if (this._jobStatus_ === STATUS_DONE || this._jobStatus_ === STATUS_ERROR) {
            this._currentSearchType_ = null;
            console.log('Cleared search type during final cleanup');
        } else {
            console.log('Skipping search type clear - searches may still be running');
        }
        
        removeUA();
        console.log('Search cleanup completed, final status:', this._jobStatus_);
    }

    async _requestBingSearch() {
        // FIXED BUG: Always initialize the status if needed
        if (!this._currentSearchType_) {
            console.warn('Search type not initialized, determining appropriate type...');
            
            // Determine which search type to start with based on completion status
            const pcCompleted = this._status_?.pcSearchStatus?.isCompleted;
            const mbCompleted = this._status_?.mbSearchStatus?.isCompleted;
            
            if (!pcCompleted) {
                console.log('Starting with PC search');
                this._currentSearchType_ = 0; // SEARCH_TYPE_PC_SEARCH
                removeUA();
                setPCReqHeaders();
            } else if (!mbCompleted) {
                console.log('Starting with Mobile search');
                this._currentSearchType_ = 1; // SEARCH_TYPE_MB_SEARCH
                removeUA();
                setMbReqHeaders();
            } else {
                console.warn('Both search types appear completed, defaulting to PC search');
                this._currentSearchType_ = 0; // SEARCH_TYPE_PC_SEARCH
                removeUA();
                setPCReqHeaders();
            }
            
            console.log('Search type initialized to:', this._currentSearchType_);
        }
        
        this._jobStatus_ = STATUS_BUSY;
        const searchType = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ? 'PC' : 'Mobile';
        const sessionStartCount = this._currentSearchCount_; // Remember starting count for session
        
        try {
            // Main search loop - iterative instead of recursive
            let loopCounter = 0;
            const MAX_LOOP_ITERATIONS = 50; // Prevent infinite loops
            
            while (!this._isCurrentSearchCompleted() && this._jobStatus_ === STATUS_BUSY) {
                
                // CIRCUIT BREAKER: Prevent infinite loops
                loopCounter++;
                if (loopCounter > MAX_LOOP_ITERATIONS) {
                    console.error(`Search loop exceeded ${MAX_LOOP_ITERATIONS} iterations, stopping to prevent infinite loop`);
                    this._jobStatus_ = STATUS_DONE;
                    break;
                }
                
                // CIRCUIT BREAKER: Check for excessive search count regardless of other conditions
                if (this._currentSearchCount_ > 100) {
                    console.error(`Search count ${this._currentSearchCount_} is excessive, stopping to prevent infinite loop`);
                    this._jobStatus_ = STATUS_DONE;
                    break;
                }
                
                // Debug: Log loop entry conditions
                console.log(`Search loop iteration ${loopCounter} - Current: ${this._currentSearchCount_}, Max: ${this._getCurrentMaxSearches()}, Completed: ${this._isCurrentSearchCompleted()}, Status: ${this._jobStatus_}`);
                
                // Ensure search type is still properly set - if lost, try to restore it intelligently
                if (!this._currentSearchType_) {
                    console.warn('Search type lost during loop, attempting to restore based on context');
                    
                    // Try to determine correct search type based on current search context
                    const pcCompleted = this._status_?.pcSearchStatus?.isCompleted;
                    const mbCompleted = this._status_?.mbSearchStatus?.isCompleted;
                    
                    if (!pcCompleted) {
                        console.log('Restoring PC search type');
                        this._currentSearchType_ = 0; // SEARCH_TYPE_PC_SEARCH
                        removeUA();
                        setPCReqHeaders();
                    } else if (!mbCompleted) {
                        console.log('Restoring Mobile search type');
                        this._currentSearchType_ = 1; // SEARCH_TYPE_MB_SEARCH
                        removeUA();
                        setMbReqHeaders();
                    } else {
                        console.error('Both search types completed but loop still running, stopping to prevent infinite loop');
                        this._jobStatus_ = STATUS_DONE;
                        break;
                    }
                    
                    // Double-check that we successfully restored the search type
                    if (this._currentSearchType_ === undefined || this._currentSearchType_ === null) {
                        console.error('Failed to restore search type, stopping to prevent infinite loop');
                        this._jobStatus_ = STATUS_ERROR;
                        break;
                    } else {
                        console.log('Successfully restored search type:', this._currentSearchType_);
                    }
                }
                
                // CIRCUIT BREAKER: Additional completion check after search type restoration
                if (this._isCurrentSearchCompleted()) {
                    console.log('Searches completed after search type restoration, ending loop');
                    break;
                }
                
                console.log(`Starting search ${this._currentSearchCount_ + 1}/${this._getCurrentMaxSearches()}`);
                
                // Perform a single search
                const searchResult = await this._performSingleSearch(searchType);
                
                if (!searchResult.success) {
                    console.error('Single search failed:', searchResult.error);
                    break;
                }
                
                // Debug: Log post-search status
                console.log(`Post-search debug - Current: ${this._currentSearchCount_}, Max: ${this._getCurrentMaxSearches()}, Completed: ${this._isCurrentSearchCompleted()}`);
                
                // Check if we should continue
                if (this._isCurrentSearchCompleted()) {
                    console.log('All searches completed for this type');
                    break;
                }
                
                // Wait between searches, but skip wait after the very first search of a new session
                if (this._jobStatus_ === STATUS_BUSY) {
                    const isFirstSearchOfSession = (this._currentSearchCount_ === sessionStartCount + 1);
                    
                    if (isFirstSearchOfSession) {
                        console.log('Skipping wait after first search of session - starting next search immediately');
                        // Set timing for progress display but don't actually wait
                        const now = new Date();
                        this._searchStartTime = now;
                        this._nextSearchTime = new Date(now.getTime() + this._searchIntervalMS);
                    } else {
                        console.log(`Waiting ${this._searchIntervalMS}ms before next search`);
                        await this._waitBetweenSearches();
                    }
                }
            }
            
            console.log(`Search session ended. Completed: ${this._currentSearchCount_}/${this._getCurrentMaxSearches()}`);
            
            // Set job status to done when loop completes normally
            if (this._jobStatus_ === STATUS_BUSY) {
                this._jobStatus_ = STATUS_DONE;
                console.log('Search session completed normally, status set to DONE');
            }
            
            // Update status to mark this search type as completed if we reached the target
            if (this._isCurrentSearchCompleted()) {
                try {
                    console.log(`Marking ${searchType} searches as completed in status`);
                    
                    // Mark the specific search type as completed
                    if (this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH && this._status_.pcSearchStatus) {
                        this._status_.pcSearchStatus.isCompleted = true;
                        console.log('PC search marked as completed');
                    } else if (this._currentSearchType_ == SEARCH_TYPE_MB_SEARCH && this._status_.mbSearchStatus) {
                        this._status_.mbSearchStatus.isCompleted = true;
                        console.log('Mobile search marked as completed');
                    }
                    
                    console.log('Updating status after marking completion');
                    await this._status_.update();
                } catch (error) {
                    console.error('Failed to update status after search completion:', error);
                }
            }
            
        } catch (error) {
            console.error('Critical error in search loop:', error);
            this._jobStatus_ = STATUS_ERROR;
        } finally {
            // Ensure proper cleanup when this specific search session ends
            if (this._jobStatus_ !== STATUS_BUSY) {
                console.log('_requestBingSearch session ended, performing local cleanup');
                removeUA(); // Clean up user agent
                
                // Don't clear search type here as other searches might still be running
                // Let the main cleanup handle that
            }
        }
    }

    async _requestLimitedBingSearch(maxSearches) {
        // FIXED BUG: Always initialize the status if needed
        if (!this._currentSearchType_) {
            console.warn('Search type not initialized, defaulting to PC search');
            this._preparePCSearch();
        }
        
        this._jobStatus_ = STATUS_BUSY;
        const searchType = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ? 'PC' : 'Mobile';
        const startingCount = this._currentSearchCount_;
        const sessionStartCount = this._currentSearchCount_; // Remember starting count for session
        
        try {
            // Limited search loop - perform only maxSearches
            while (!this._isCurrentSearchCompleted() && 
                   this._jobStatus_ === STATUS_BUSY &&
                   (this._currentSearchCount_ - startingCount) < maxSearches) {
                
                // Ensure search type is still properly set - DON'T reset during active loop
                if (!this._currentSearchType_) {
                    console.error('Search type lost during limited search loop, stopping to prevent infinite loop');
                    this._jobStatus_ = STATUS_ERROR;
                    break;
                }
                
                console.log(`Starting limited search ${this._currentSearchCount_ + 1}/${this._getCurrentMaxSearches()} (batch: ${(this._currentSearchCount_ - startingCount) + 1}/${maxSearches})`);
                
                // Perform a single search
                const searchResult = await this._performSingleSearch(searchType);
                
                if (!searchResult.success) {
                    console.error('Single search failed:', searchResult.error);
                    break;
                }
                
                // Check if we should continue
                if (this._isCurrentSearchCompleted()) {
                    console.log('All searches completed for this type');
                    break;
                }
                
                // Check if we've reached the batch limit
                if ((this._currentSearchCount_ - startingCount) >= maxSearches) {
                    console.log(`Batch limit of ${maxSearches} searches reached`);
                    break;
                }
                
                // Wait between searches, but skip wait after the very first search of a new session
                if (this._jobStatus_ === STATUS_BUSY) {
                    const isFirstSearchOfSession = (this._currentSearchCount_ === sessionStartCount + 1);
                    
                    if (isFirstSearchOfSession) {
                        console.log('Skipping wait after first search of session - starting next search immediately');
                        // Set timing for progress display but don't actually wait
                        const now = new Date();
                        this._searchStartTime = now;
                        this._nextSearchTime = new Date(now.getTime() + this._searchIntervalMS);
                    } else {
                        console.log(`Waiting ${this._searchIntervalMS}ms before next search`);
                        await this._waitBetweenSearches();
                    }
                }
            }
            
            const searchesPerformed = this._currentSearchCount_ - startingCount;
            console.log(`Limited search session ended. Performed: ${searchesPerformed}/${maxSearches} searches`);
            
            // Update status to mark this search type as completed if we reached the target
            if (this._isCurrentSearchCompleted()) {
                try {
                    console.log('Updating status to mark search type as completed (limited search)');
                    await this._status_.update();
                } catch (error) {
                    console.error('Failed to update status after limited search completion:', error);
                }
            }
            
        } catch (error) {
            console.error('Critical error in limited search loop:', error);
            this._jobStatus_ = STATUS_ERROR;
        }
    }
    
    async _performSingleSearch(searchType) {
        const MAX_RETRIES = 3;
        let retries = 0;
        let waitTime = 30000;
        
        while (retries <= MAX_RETRIES) {
            try {
                // Check connectivity
                const isConnected = await checkInternetConnectivity();
                if (!isConnected) {
                    debugLog(`No internet connection for ${searchType} search, waiting...`, LOG_LEVELS.WARN);
                    await this._notifyConnectivityIssue(searchType);
                    await sleep(120000); // 2 minutes
                    retries++;
                    continue;
                }
                
                // Get search word
                const searchWord = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ?
                    await this._googleTrend_.nextPCWord :
                    await this._googleTrend_.nextMBWord;
                    
                console.log(`Performing ${searchType} search ${this._currentSearchCount_ + 1}: "${searchWord}"`);
                
                // Notify that search is starting
                await this._notifySearchStarting(searchType, searchWord);
                
                // Perform the search with mobile-specific adaptations
                const searchUrl = this._buildSearchUrl(searchWord, searchType);
                const searchHeaders = this._buildSearchHeaders(searchType);
                
                const response = await fetch(searchUrl, {
                    method: 'GET',
                    headers: searchHeaders
                });
                
                if (response.status != 200) {
                    throw new FetchResponseAnomalyException('Search');
                }
                
                // Update progress
                this._currentSearchCount_++;
                await this._updateSearchProgress(searchWord);
                await this._notifySearchCompleted(searchType);
                
                return { success: true };
                
            } catch (ex) {
                retries++;
                console.warn(`Search attempt ${retries}/${MAX_RETRIES} failed:`, ex.message);
                
                if (retries <= MAX_RETRIES) {
                    if (ex instanceof NetworkException || !navigator.onLine) {
                        waitTime = Math.min(waitTime * 2, 300000);
                        await this._notifyConnectivityIssue(searchType, ex.message);
                    }
                    await sleep(waitTime);
                } else {
                    return { success: false, error: ex };
                }
            }
        }
        
        return { success: false, error: 'Max retries exceeded' };
    }
    
    async _updateSearchProgress(searchWord) {
        // Use mobile-specific delays for mobile searches
        let waitMs = this._searchIntervalMS;
        if (this._currentSearchType_ === SEARCH_TYPE_MB_SEARCH) {
            waitMs = await this._getMobileSearchDelay();
            console.log(`Using mobile-optimized delay: ${waitMs}ms (${Math.floor(waitMs/1000)}s)`);
        }
        
        const now = new Date();
        this._searchStartTime = now;
        this._nextSearchTime = new Date(now.getTime() + waitMs);
        this._currentSearchTerm = searchWord;
        
        console.log(`Search completed. Progress: ${this._currentSearchCount_}/${this._getCurrentMaxSearches()}`);
        
        await this._saveSearchProgress();
        
        debugLog('Search timing:', {
            currentTime: now.toLocaleTimeString(),
            nextSearchAt: this._nextSearchTime.toLocaleTimeString(),
            waitMinutes: Math.floor(waitMs/60000),
            waitSeconds: Math.floor((waitMs % 60000)/1000),
            remaining: this._getCurrentMaxSearches() - this._currentSearchCount_
        }, LOG_LEVELS.INFO);
    }
    
    async _waitBetweenSearches() {
        const startTime = Date.now();
        const originalNextSearchTime = this._nextSearchTime.getTime();
        this._jobStatus_ = STATUS_BUSY; // Ensure we stay busy during wait
        
        // Set up periodic progress notifications during the wait
        const progressInterval = Math.min(1000, this._searchIntervalMS / 20); // Check more frequently for force action
        let progressTimer;
        let forceTriggered = false;
        
        const sendProgressUpdate = () => {
            try {
                chrome.runtime.sendMessage({
                    action: 'searchProgressUpdate',
                    content: this.getSearchProgress()
                }, (response) => {
                    if (chrome.runtime.lastError) {
                        // Silently handle message port errors - these are expected during extension lifecycle
                        // Only log occasionally to avoid spam
                        if (Math.random() < 0.01) { // Log 1% of errors
                            console.log('Progress update message failed (extension may be reloading)');
                        }
                    }
                });
            } catch (err) {
                console.warn('Failed to send progress update:', err);
            }
        };
        
        // Start sending periodic updates and checking for force action
        progressTimer = setInterval(() => {
            // CRITICAL: Don't process force actions if searches are already completed
            if (this._isCurrentSearchCompleted()) {
                console.log('Searches completed - skipping force action check');
                forceTriggered = true; // End wait immediately
                return;
            }
            
            sendProgressUpdate();
            
            // Check if force action was triggered (nextSearchTime changed or is now)
            const currentTime = Date.now();
            const currentNextSearchTime = this._nextSearchTime.getTime();
            
            if (currentNextSearchTime !== originalNextSearchTime) {
                console.log('Next search time was modified - force action detected', {
                    original: new Date(originalNextSearchTime).toLocaleTimeString(),
                    current: new Date(currentNextSearchTime).toLocaleTimeString(),
                    currentTime: new Date(currentTime).toLocaleTimeString()
                });
                forceTriggered = true;
            } else if (currentNextSearchTime <= currentTime) {
                console.log('Search time reached naturally');
                forceTriggered = true;
            }
        }, progressInterval);
        
        try {
            // Wait until the scheduled time, but check periodically for force action
            while (Date.now() < this._nextSearchTime.getTime() && this._jobStatus_ === STATUS_BUSY && !forceTriggered) {
                // CRITICAL: Exit wait immediately if searches are completed
                if (this._isCurrentSearchCompleted()) {
                    console.log('Searches completed during wait - ending wait immediately');
                    break;
                }
                
                const remainingTime = this._nextSearchTime.getTime() - Date.now();
                const sleepTime = Math.min(500, remainingTime); // Check every 500ms or remaining time
                
                if (sleepTime > 0) {
                    await sleep(sleepTime);
                }
            }
            
            if (this._isCurrentSearchCompleted()) {
                console.log('Search wait ended - searches completed');
            } else if (forceTriggered) {
                console.log('Search wait interrupted by force action');
            } else if (this._jobStatus_ !== STATUS_BUSY) {
                console.log('Search wait interrupted by status change');
            } else {
                console.log('Search wait completed normally');
            }
            
        } finally {
            // Always clear the progress timer
            if (progressTimer) {
                clearInterval(progressTimer);
            }
        }
        
        // Double check we should continue
        if (this._jobStatus_ !== STATUS_BUSY) {
            console.log('Search job status changed during wait, stopping');
            return;
        }
    }
    
    async _notifySearchStarting(searchType, searchWord) {
        try {
            await new Promise((resolve) => {
                chrome.runtime.sendMessage(
                    {
                        action: 'searchStarting',
                        content: {
                            type: searchType,
                            searchWord: searchWord,
                            current: this._currentSearchCount_ + 1, // Next search number
                            total: this._getCurrentMaxSearches(),
                            timestamp: Date.now()
                        }
                    },
                    (response) => {
                        if (chrome.runtime.lastError) {
                            console.warn('Message sending failed:', chrome.runtime.lastError.message);
                        }
                        resolve(response || {success: true});
                    }
                );
                setTimeout(resolve, 1000);
            });
        } catch (err) {
            console.warn('Failed to send search starting notification:', err);
        }
    }
    
    async _notifyConnectivityIssue(searchType, errorMessage = null) {
        try {
            await new Promise((resolve) => {
                chrome.runtime.sendMessage(
                    { 
                        action: 'connectivityIssue', 
                        searchType: searchType,
                        error: errorMessage
                    },
                    (response) => {
                        if (chrome.runtime.lastError) {
                            console.warn('Connectivity message failed:', chrome.runtime.lastError.message);
                        }
                        resolve(response);
                    }
                );
                setTimeout(resolve, 1000);
            });
        } catch (err) {
            console.warn('Failed to send connectivity message:', err);
        }
    }
    
    async _notifySearchCompleted(searchType) {
        try {
            await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    console.log('Message timeout reached');
                    resolve({success: true, timedOut: true});
                }, 3000);
                
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
                        clearTimeout(timeout);
                        if (chrome.runtime.lastError) {
                            console.warn('Search completed message failed:', chrome.runtime.lastError.message);
                        }
                        resolve(response || {success: true});
                    }
                );
            });
        } catch (err) {
            console.warn('Could not notify about search completion:', err);
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
            'calculatedOn': null,
            'settingsHash': null
        });
        
        // Get current settings to compare
        const settings = await chrome.storage.sync.get({
            baseSearchCount: 30,
            searchVariation: 5,
            baseSearchInterval: 15,
            intervalVariation: 300,
            interleaveSearches: false,
            smartSwitching: true
        });
        
        // Create a hash of the settings that affect intervals
        const currentSettingsHash = JSON.stringify({
            baseSearchCount: settings.baseSearchCount,
            searchVariation: settings.searchVariation,
            baseSearchInterval: settings.baseSearchInterval,
            intervalVariation: settings.intervalVariation
        });
        
        // Check if we have valid cached settings from today AND settings haven't changed
        const hasValidCache = data.calculatedOn && 
                             new Date(data.calculatedOn).toLocaleDateString() === today &&
                             data.targetSearchCount !== null && 
                             data.searchIntervalMS !== null &&
                             data.settingsHash === currentSettingsHash;
        
        if (hasValidCache) {
            console.log('Using cached search settings from today:', {
                targetCount: data.targetSearchCount,
                intervalMS: data.searchIntervalMS
            });
            
            this._targetSearchCount = data.targetSearchCount;
            this._searchIntervalMS = data.searchIntervalMS;
        } else {
            if (data.calculatedOn && data.settingsHash !== currentSettingsHash) {
                console.log('Settings changed since last calculation, recalculating intervals');
            }
            
            // Calculate new intervals since cache is invalid or settings changed
            this._baseSearchCount = settings.baseSearchCount;
            this._searchVariation = settings.searchVariation;
            
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
            
            // Cache the new settings with hash
            await chrome.storage.local.set({
                'targetSearchCount': this._targetSearchCount,
                'searchIntervalMS': this._searchIntervalMS,
                'calculatedOn': new Date().toISOString(),
                'settingsHash': currentSettingsHash
            });
        }
        
        // Always set these for consistency
        this._baseSearchCount = settings.baseSearchCount;
        this._searchVariation = settings.searchVariation;

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
        // Priority 1: Use status-based count as primary source (what Microsoft actually needs)
        if (this._status_ && this._currentSearchType_) {
            const statusCount = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ? 
                this._status_.pcSearchStatus?.searchNeededCount : 
                this._status_.mbSearchStatus?.searchNeededCount;
                
            if (statusCount && statusCount > 0) {
                console.log(`Using status-based search count: ${statusCount}`);
                return statusCount;
            }
        }
        
        // Priority 2: Use stored target count as secondary source
        if (this._targetSearchCount && this._targetSearchCount > 0) {
            // Only log this occasionally to prevent spam
            if (!this._lastTargetCountLog || Date.now() - this._lastTargetCountLog > 60000) {
                console.log(`Using calculated target count: ${this._targetSearchCount}`);
                this._lastTargetCountLog = Date.now();
            }
            return this._targetSearchCount;
        }
        
        // Priority 3: Final fallback to reasonable defaults
        const defaultCount = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ? 30 : 20;
        
        // Only log warning once per session
        if (!this._fallbackWarningLogged) {
            console.warn('Using fallback search count:', {
                searchType: this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ? 'PC' : 'Mobile',
                targetCount: this._targetSearchCount,
                statusAvailable: !!this._status_,
                usingDefault: defaultCount
            });
            this._fallbackWarningLogged = true;
        }
        
        return defaultCount;
    }

    _getBingSearchUrl() {
        const word = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ?
            this._googleTrend_.nextPCWord :
            this._googleTrend_.nextMBWord;

        return `https://www.bing.com/search?q=${word}&form=QBRE`;
    }

    _isCurrentSearchCompleted() {
        // Get current progress first - this is essential for circuit breaker logic
        const currentProgress = this._currentSearchCount_;
        
        // CIRCUIT BREAKER: If search count is clearly excessive, force completion
        // This prevents infinite loops when other logic fails
        if (currentProgress > 100) {
            console.warn(`Search count ${currentProgress} is excessive, forcing completion to prevent infinite loop`);
            return true;
        }
        
        // Enhanced validation and initialization check
        if (!this._currentSearchType_) {
            // Only log this warning occasionally to prevent log spam
            if (!this._lastSearchTypeWarning || Date.now() - this._lastSearchTypeWarning > 10000) {
                console.warn('Search type not initialized in completion check');
                this._lastSearchTypeWarning = Date.now();
            }
            
            // CIRCUIT BREAKER: If we have a reasonable search count but no type, assume completion
            if (currentProgress >= 20) {
                console.warn(`Search type lost but count ${currentProgress} suggests completion, marking as done`);
                return true;
            }
            return false;
        }
        
        if (!this._status_) {
            console.warn('Status not available in completion check');
            
            // CIRCUIT BREAKER: Use basic count logic when status is unavailable
            const defaultNeeded = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ? 30 : 20;
            if (currentProgress >= defaultNeeded) {
                console.warn(`Status unavailable but count ${currentProgress} >= ${defaultNeeded}, assuming completion`);
                return true;
            }
            return false;
        }

        const type = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ? 'PC' : 'Mobile';
        const status = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ? 
            this._status_.pcSearchStatus : 
            this._status_.mbSearchStatus;
            
        if (!status) {
            console.warn(`No ${type} status available for completion check`);
            
            // CIRCUIT BREAKER: Use type-based default logic
            const defaultNeeded = type === 'PC' ? 30 : 20;
            if (currentProgress >= defaultNeeded) {
                console.warn(`Status unavailable but count ${currentProgress} >= ${defaultNeeded} for ${type}, assuming completion`);
                return true;
            }
            return false;
        }
            
        // First check if the search type is already marked as completed
        if (status.isCompleted) {
            console.log(`${type} searches already completed according to status`);
            return true;
        }
        
        // Get the target search count with proper priority (match _getCurrentMaxSearches logic)
        let neededCount = 0;
        
        // Priority 1: Use status searchNeededCount (what Microsoft actually needs)
        if (status.searchNeededCount && status.searchNeededCount > 0) {
            neededCount = status.searchNeededCount;
            console.log(`Using status-based needed count for completion: ${neededCount}`);
        }
        // Priority 2: Use the stored target count if available
        else if (this._targetSearchCount && this._targetSearchCount > 0) {
            neededCount = this._targetSearchCount;
            console.log(`Using cached target count for completion: ${neededCount}`);
        }
        // Priority 3: Use reasonable defaults
        else {
            neededCount = type === 'PC' ? 30 : 20;
            console.warn(`Using default search count for ${type} completion: ${neededCount}`);
        }

        const isComplete = currentProgress >= neededCount;

        console.log(`${type} search completion check:`, {
            current: currentProgress,
            needed: neededCount,
            isComplete: isComplete,
            statusValid: status.isValid,
            statusCompleted: status.isCompleted,
            targetFromCache: this._targetSearchCount,
            targetFromStatus: status.searchNeededCount
        });

        return isComplete;
    }

    getSearchProgress() {
        if (this._searchStartTime && this._nextSearchTime) {
            const now = new Date();
            const totalInterval = this._searchIntervalMS;
            const timeElapsed = now - this._searchStartTime;
            const timeRemaining = Math.max(0, this._nextSearchTime - now);
            
            // Validate that we have valid timing data
            if (!totalInterval || totalInterval <= 0) {
                console.warn('Invalid total interval for progress calculation:', totalInterval);
                return { inProgress: false };
            }
            
            // Calculate percent completion of current interval (how much time has elapsed)
            let rawProgress = 0;
            if (timeRemaining <= 0) {
                // Search time has been reached
                rawProgress = 100;
            } else if (timeElapsed >= totalInterval) {
                // We've been waiting longer than expected - cap at 100%
                rawProgress = 100;
            } else {
                // Normal case: calculate based on elapsed time vs total interval
                rawProgress = Math.floor((timeElapsed / totalInterval) * 100);
            }
            
            // Ensure valid range
            const percentComplete = Math.max(0, Math.min(100, rawProgress));
            
            // Reset progress tracking when starting a new search interval
            // (detect new search by checking if current count changed)
            const currentSearchKey = `${this._currentSearchType_}-${this._currentSearchCount_}`;
            if (this._lastSearchKey !== currentSearchKey) {
                this._lastCountdownProgress = null; // Reset smoothing for new search
                this._lastSearchKey = currentSearchKey;
                console.log('New search detected, reset progress tracking:', currentSearchKey);
            }
            
            // Apply smoothing only to prevent backwards movement within same search
            let smoothedProgress = percentComplete;
            if (this._lastCountdownProgress !== null) {
                // Only smooth if progress would go backwards significantly (>2%)
                if (percentComplete < this._lastCountdownProgress - 2) {
                    smoothedProgress = this._lastCountdownProgress;
                    console.log('Progress smoothed to prevent jump:', 
                        `raw: ${percentComplete}%, smoothed: ${smoothedProgress}%`);
                }
            }
            
            // Update tracking
            this._lastCountdownProgress = smoothedProgress;
            
            // Use smoothed progress for display
            const finalPercentComplete = smoothedProgress;
            
            // Get the next search term that will be used
            let nextSearchTerm;
            try {
                nextSearchTerm = this._googleTrend_ ? this._googleTrend_.getNextTermForDisplay() : '[next term]';
                
                // Ensure we always have a string
                if (typeof nextSearchTerm !== 'string') {
                    console.warn('Next search term is not a string:', typeof nextSearchTerm, nextSearchTerm);
                    nextSearchTerm = '[next term]';
                }
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
                percentComplete: finalPercentComplete,
                searchTerm: this._currentSearchTerm || '[searching...]',
                nextSearchTerm: nextSearchTerm,
                
                // Add additional timing details for debugging
                elapsedMs: timeElapsed,
                totalIntervalMs: totalInterval,
                rawProgress: rawProgress,
                
                // Add search state information
                isPaused: this._pausedBySchedule || false,
                searchState: this._jobStatus_
            };
            
            // Add debug logging for progress issues (throttled to prevent spam)
            if (finalPercentComplete === 0 && timeRemaining > (totalInterval * 0.9)) {
                if (!this._lastProgressAnomaly || Date.now() - this._lastProgressAnomaly > 30000) {
                    console.warn('Progress calculation anomaly detected:', {
                        percentComplete: finalPercentComplete,
                        timeRemaining: Math.floor(timeRemaining / 1000) + 's',
                        totalInterval: Math.floor(totalInterval / 1000) + 's',
                        timeElapsed: Math.floor(timeElapsed / 1000) + 's',
                        rawProgress: rawProgress
                    });
                    this._lastProgressAnomaly = Date.now();
                }
            }
            
            console.log('Search progress:', progress);
            return progress;
        }
        
        return {
            inProgress: false
        };
    }

    /**
     * Skips the current search term and selects a new random term for the next search
     * @returns {Promise<boolean>} True if skip was successful, false otherwise
     */
    async skipCurrentSearch() {
        console.log('Skipping current search term');
        
        if (!this._searchStartTime || !this._nextSearchTime) {
            console.log('No active search session to skip term for');
            return false;
        }
        
        try {
            // Force the GoogleTrend object to select a new next term
            if (this._googleTrend_ && typeof this._googleTrend_._updateCachedNextTerm === 'function') {
                await this._googleTrend_._updateCachedNextTerm();
                console.log('Successfully forced new search term selection after skip');
            } else {
                console.warn('GoogleTrend does not support cached term updates');
            }
            
            // Send notification about the skip
            await this._notifySearchTermSkipped();
            
            console.log('Search term skipped successfully');
            return true;
        } catch (error) {
            console.error('Error skipping search term:', error);
            return false;
        }
    }

    /**
     * Forces the next search to start immediately by skipping the countdown
     * @returns {Promise<boolean>} True if force was successful, false otherwise
     */
    async forceNextSearch() {
        console.log('Forcing next search to start immediately');
        
        if (!this._searchStartTime || !this._nextSearchTime) {
            console.log('No active search session to force');
            return false;
        }
        
        try {
            const currentTime = new Date();
            const oldNextSearchTime = this._nextSearchTime.getTime();
            
            console.log('Force search timing:', {
                currentTime: currentTime.toLocaleTimeString(),
                oldNextSearchTime: this._nextSearchTime.toLocaleTimeString(),
                timeUntilNext: Math.floor((oldNextSearchTime - currentTime.getTime()) / 1000) + ' seconds'
            });
            
            // Set the next search time to now to trigger immediate search
            this._nextSearchTime = new Date();
            
            console.log('Force search updated timing:', {
                newNextSearchTime: this._nextSearchTime.toLocaleTimeString(),
                shouldTriggerImmediately: this._nextSearchTime.getTime() <= currentTime.getTime()
            });
            
            // Send notification about the force action
            await this._notifySearchForced();
            
            console.log('Next search forced to start immediately');
            return true;
        } catch (error) {
            console.error('Error forcing next search:', error);
            return false;
        }
    }

    /**
     * Notifies about a search term being skipped
     * @private
     */
    async _notifySearchTermSkipped() {
        try {
            const nextTerm = this._googleTrend_?.getNextTermForDisplay?.() || '[next term]';
            
            await new Promise((resolve) => {
                chrome.runtime.sendMessage(
                    {
                        action: 'searchTermSkipped',
                        content: {
                            type: this._currentSearchType_ === SEARCH_TYPE_PC_SEARCH ? 'PC' : 'Mobile',
                            current: this._currentSearchCount_,
                            total: this._getCurrentMaxSearches(),
                            timestamp: Date.now(),
                            newTerm: nextTerm
                        }
                    },
                    (response) => {
                        if (chrome.runtime.lastError) {
                            console.warn('Skip term message failed:', chrome.runtime.lastError.message);
                        }
                        resolve(response || { success: true });
                    }
                );
                setTimeout(resolve, 1000);
            });
        } catch (err) {
            console.warn('Failed to send search term skipped notification:', err);
        }
    }

    /**
     * Notifies about a search being forced to start
     * @private
     */
    async _notifySearchForced() {
        try {
            await new Promise((resolve) => {
                chrome.runtime.sendMessage(
                    {
                        action: 'searchForced',
                        content: {
                            type: this._currentSearchType_ === SEARCH_TYPE_PC_SEARCH ? 'PC' : 'Mobile',
                            current: this._currentSearchCount_,
                            total: this._getCurrentMaxSearches(),
                            timestamp: Date.now()
                        }
                    },
                    (response) => {
                        if (chrome.runtime.lastError) {
                            console.warn('Force search message failed:', chrome.runtime.lastError.message);
                        }
                        resolve(response || { success: true });
                    }
                );
                setTimeout(resolve, 1000);
            });
        } catch (err) {
            console.warn('Failed to send search forced notification:', err);
        }
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

    // Add method to force stop search activities (for scheduling)
    async forceStop() {
        console.log('Force stopping search quest due to schedule pause');
        // Store current progress before stopping
        try {
            await this._saveSearchProgress();
        } catch (error) {
            console.error('Error saving progress during force stop:', error);
        }
        
        // Add debugging for each property assignment
        try {
            console.log('Setting _jobStatus_ to STATUS_DONE');
            // Check if we can set the property
            if (this.hasOwnProperty('_jobStatus_') || '_jobStatus_' in this) {
                this._jobStatus_ = STATUS_DONE;
                console.log('Successfully set _jobStatus_');
            } else {
                console.warn('Cannot set _jobStatus_ - property not accessible');
                // Try alternative approach - use a flag that other methods can check
                this._forceStopped = true;
            }
        } catch (error) {
            console.error('Error setting _jobStatus_:', error);
            // Set alternative flag
            this._forceStopped = true;
        }
        
        // Save pause timestamp and reason (before clearing currentSearchType)
        const currentSearchType = this._currentSearchType_; // Save before clearing
        
        try {
            console.log('Setting _currentSearchType_ to null');
            this._currentSearchType_ = null;
            console.log('Successfully set _currentSearchType_');
        } catch (error) {
            console.error('Error setting _currentSearchType_:', error);
            throw error;
        }
        
        try {
            console.log('Setting _nextSearchTime to null');
            this._nextSearchTime = null;
            console.log('Successfully set _nextSearchTime');
        } catch (error) {
            console.error('Error setting _nextSearchTime:', error);
            throw error;
        }
        
        chrome.storage.local.set({
            'searchPausedAt': new Date().toISOString(),
            'pausedSearchCount': this._currentSearchCount_,
            'pausedSearchType': currentSearchType == SEARCH_TYPE_PC_SEARCH ? 'pc' : 'mb',
            'searchPausedReason': 'manualStop'
        });
        // Set flag to indicate this was paused manually
        this._pausedBySchedule = false;
        this._manuallyPaused = true;
        console.log('Search quest successfully stopped');
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
