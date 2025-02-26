class GoogleTrend {
    constructor() {
        this.reset();
    }

    get nextPCWord() {
        if (this._pcWordPointer_ >= this._googleTrendWords_.words.length-1) {
            this._pcWordPointer_ = -1;
        }
        this._pcWordPointer_ ++;
        return this._googleTrendWords_.words[this._pcWordPointer_];
    }

    get nextMBWord() {
        if (this._mbWordPointer_ >= this._googleTrendWords_.words.length-1) {
            this._mbWordPointer_ = -1;
        }
        this._mbWordPointer_ ++;
        return this._googleTrendWords_.words[this._mbWordPointer_];
    }

    reset() {
        this._googleTrendWords_ = {date: '', words: []};
        this._pcWordPointer_ = -1;
        this._mbWordPointer_ = -1;
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
        // Skip fetch attempt since we're using fallback terms
        this._useFallbackTerms();
    }

    _useFallbackTerms() {
        const fallbackTerms = [
            'news today', 'weather forecast', 'local events',
            'sports scores', 'movie reviews', 'tech news',
            'recipes', 'health tips', 'travel destinations',
            'book reviews', 'local news', 'music reviews',
            'science news', 'history facts', 'space exploration'
        ];
        this._googleTrendWords_.words = fallbackTerms;
        this._googleTrendWords_.date = this._getyyyymmdd(new Date());
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
}
