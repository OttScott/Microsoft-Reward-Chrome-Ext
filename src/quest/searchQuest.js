class SearchQuest {
    constructor(googleTrend) {
        this._googleTrend_ = googleTrend;
        // Set to 15 minutes + random 0-15 minutes
        const baseInterval = 15 * 60 * 1000; // 15 minutes in ms
        const randomInterval = Math.floor(Math.random() * 900) * 1000; // 0-900 seconds in ms
        this._searchIntervalMS = baseInterval + randomInterval;
        
        console.log('Search interval configured:', {
            base: '15 minutes',
            random: `${Math.floor(randomInterval/1000)} seconds`,
            total: `${Math.floor(this._searchIntervalMS/1000)} seconds`
        });

        this.reset();
        this._loadSearchSettings();
        this._targetSearchCount = null;
    }

    reset() {
        this._status_ = null;
        this._pcSearchWordIdx_ = 0;
        this._mbSearchWordIdx_ = 0;
        this._currentSearchCount_ = 0;
        this._currentSearchType_ = null;
        this._jobStatus_ = STATUS_NONE;
        this._targetSearchCount = null;
    }

    get jobStatus() {
        return this._jobStatus_;
    }

    async doWork(status) {
        console.assert(status != null);

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
        while (true) {
            if (this._status_.isSearchCompleted) {
                return;
            }

            if (this._status_.jobStatus == STATUS_ERROR || !this._status_.summary.isValid) {
                this._jobStatus_ = STATUS_ERROR;
                return;
            }

            await this._startSearchQuests();

            const flag = await this.isSearchSuccessful();
            if (flag > 0) {
                await this._getAlternativeUA(flag);
            }
        }
    }

    async _startSearchQuests() {
        await this._doPcSearch();
        
        const settings = await chrome.storage.sync.get({ disableMobile: false });
        if (!settings.disableMobile) {
            await this._doMbSearch();
        } else {
            console.log('Mobile searches disabled in settings');
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
        
        await this._status_.update();
        
        console.log('Search progress after update:', {
            pc: this._status_.pcSearchStatus.progress,
            mobile: this._status_.mbSearchStatus.progress
        });

        const pcFailed = !this._status_.pcSearchStatus.isValidAndCompleted && 
            (pcSearchProgBefore == this._status_.pcSearchStatus.progress);
        const mbFailed = !this._status_.mbSearchStatus.isValidAndCompleted && 
            (mbSearchProgBefore == this._status_.mbSearchStatus.progress);

        return (pcFailed ? 1 : 0) + (mbFailed ? 2 : 0);
    }

    async _getAlternativeUA(flag) {
        if (flag == 3) {
            if (userAgents.pcSource == 'updated' && userAgents.mbSource == 'updated') {
                throw new UserAgentInvalidException('Cannot find working UAs for pc and mobile.');
            }
            await getUpdatedUA('both');
        } else if (flag == 1) {
            if (userAgents.pcSource == 'updated') {
                throw new UserAgentInvalidException('Cannot find a working UA for pc.');
            }
            await getUpdatedUA('pc');
        } else if (flag == 2) {
            if (userAgents.mbSource == 'updated') {
                throw new UserAgentInvalidException('Cannot find a working UA for mobile.');
            }
            await getUpdatedUA('mb');
        }
        notifyStableUAOutdated(flag);
    }

    async _doPcSearch() {
        this._initiateSearch();
        if (this._currentSearchType_ != SEARCH_TYPE_PC_SEARCH) {
            this._preparePCSearch();
        }

        await this._requestBingSearch();
    }

    async _doMbSearch() {
        this._initiateSearch();
        if (this._currentSearchType_ != SEARCH_TYPE_MB_SEARCH) {
            this._prepareMbSearch();
        }

        await this._requestBingSearch();
    }

    _initiateSearch() {
        this._currentSearchCount_ = 0;
        this._targetSearchCount = this._calculateSearchCount();
        console.log(`Initiated ${this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ? 'PC' : 'Mobile'} search session targeting ${this._targetSearchCount} searches`);
    }

    _preparePCSearch() {
        this._currentSearchType_ = SEARCH_TYPE_PC_SEARCH;
        removeUA();
        setPCReqHeaders();
    }

    _prepareMbSearch() {
        this._currentSearchType_ = SEARCH_TYPE_MB_SEARCH;
        removeUA();
        setMobileReqHeaders();
    }

    _quitSearchCleanUp() {
        if (this._jobStatus_ == STATUS_BUSY) {
            this._jobStatus_ = STATUS_DONE;
        }
        this._currentSearchType_ = null;
        removeUA();
    }

    async _requestBingSearch() {
        if (this._isCurrentSearchCompleted()) {
            return;
        }

        const searchType = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ? 'PC' : 'Mobile';
        let searchWord;
        
        try {
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
            console.log(`${searchType} search completed. Progress: ${this._currentSearchCount_}/${this._getCurrentMaxSearches()}`);
            
            // More detailed timing log
            const waitMs = this._searchIntervalMS;
            const nextTime = new Date(Date.now() + waitMs);
            console.log(`Search timing:`, {
                waitSeconds: Math.floor(waitMs/1000),
                nextSearch: nextTime.toLocaleTimeString(),
                randomization: Math.floor((waitMs - 30000)/1000)
            });
            
            await sleep(this._searchIntervalMS);
            await this._requestBingSearch();
        } catch (ex) {
            console.error('Search failed:', {
                type: searchType,
                term: searchWord,
                error: ex
            });
            throw new FetchFailedException('Search', ex);
        }
    }

    async _loadSearchSettings() {
        const settings = await chrome.storage.sync.get({
            baseCount: this._baseSearchCount,
            variation: this._searchVariation
        });
        
        // Return new calculated count for display
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
        const maxSearches = this._getCurrentMaxSearches();
        const type = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ? 'PC' : 'Mobile';
        const needed = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ? 
            this._status_.pcSearchStatus.searchNeededCount :
            this._status_.mbSearchStatus.searchNeededCount;

        console.log(`${type} search completion check:`, {
            current: this._currentSearchCount_,
            max: maxSearches,
            needed: needed,
            type: type
        });

        return this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ?
            this._currentSearchCount_ >= this._status_.pcSearchStatus.searchNeededCount :
            this._currentSearchCount_ >= this._status_.mbSearchStatus.searchNeededCount;
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
