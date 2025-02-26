class SearchQuest {
    constructor(googleTrend) {
        this._googleTrend_ = googleTrend;
        this._searchIntervalMS = this._searchIntervalMS = 900000 + Math.random()*1000*60*5;
        this.reset();
        this._loadSearchSettings();
    }

    reset() {
        this._status_ = null;
        this._pcSearchWordIdx_ = 0;
        this._mbSearchWordIdx_ = 0;
        this._currentSearchCount_ = 0;
        this._currentSearchType_ = null;
        this._jobStatus_ = STATUS_NONE;
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
        await this._doMbSearch();
        this._quitSearchCleanUp();
    }

    async isSearchSuccessful() {
        // Return:
        // 0 - successful; 1 - pc search failed; 2 - mb search failed; 3 - both failed
        const pcSearchProgBefore = this._status_.pcSearchStatus.progress;
        const mbSearchProgBefore = this._status_.mbSearchStatus.progress;
        await this._status_.update();
        const flag = (!this._status_.pcSearchStatus.isValidAndCompleted && (pcSearchProgBefore == this._status_.pcSearchStatus.progress));
        return flag + 2 * (!this._status_.mbSearchStatus.isValidAndCompleted && (mbSearchProgBefore == this._status_.mbSearchStatus.progress));
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
        const searchWord = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ?
            this._googleTrend_.nextPCWord :
            this._googleTrend_.nextMBWord;

        console.log(`Performing ${searchType} search ${this._currentSearchCount_ + 1}: "${searchWord}"`);

        try {
            const response = await fetch(this._getBingSearchUrl());
            if (response.status != 200) {
                throw new FetchResponseAnomalyException('Search');
            }
            
            this._currentSearchCount_++;
            console.log(`${searchType} search completed. Progress: ${this._currentSearchCount_}/${this._getCurrentMaxSearches()}`);
            
            await sleep(this._searchIntervalMS);
            await this._requestBingSearch();
        } catch (ex) {
            throw new FetchFailedException('Search', ex);
        }
    }

    async _loadSearchSettings() {
        const settings = await chrome.storage.sync.get({
            baseSearchCount: 30,  // default value
            searchVariation: 5    // default variation
        });
        
        this._baseSearchCount = settings.baseSearchCount;
        this._searchVariation = settings.searchVariation;
    }

    _getCurrentMaxSearches() {
        if (!this._baseSearchCount) {
            return this._status_.pcSearchStatus.searchNeededCount;
        }

        // Get random number between 0 and 1
        const randomFactor = Math.random();
        
        // Convert 0-1 range to -variation to +variation
        // 0.0 -> -variation
        // 0.5 -> 0
        // 1.0 -> +variation
        const variation = (randomFactor - 0.5) * 2 * this._searchVariation;
        
        // Round to nearest integer
        const searchCount = Math.round(this._baseSearchCount + variation);
        
        console.log(`Search count calculation:
            Base: ${this._baseSearchCount}
            Random factor: ${randomFactor.toFixed(3)}
            Variation: ${variation.toFixed(1)} (±${this._searchVariation})
            Final count: ${searchCount}`
        );
        
        return searchCount;
    }

    _getBingSearchUrl() {
        const word = this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH ?
            this._googleTrend_.nextPCWord :
            this._googleTrend_.nextMBWord;

        return `https://www.bing.com/search?q=${word}&form=QBRE`;
    }

    _isCurrentSearchCompleted() {
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
