class DailyRewardStatus {
    constructor() {
        this.reset();
    }

    reset() {
        this._summary_ = {isValid: false, earnedToday: 0, availablePoints: 0};
        this._pcSearchStatus_ = this._createSearchStatus([]);
        this._mbSearchStatus_ = this._createSearchStatus([]);
        this._quizAndDailyStatus_ = {isCompleted: false, pointsToGet: 0};
        this._jobStatus_ = STATUS_NONE;
        this._lastUpdateTime = null;
        this._errMsg_ = null;
    }

    get summary() {
        return this._summary_;
    }

    get pcSearchStatus() {
        return this._pcSearchStatus_;
    }

    get mbSearchStatus() {
        return this._mbSearchStatus_;
    }

    get quizAndDailyStatus() {
        return this._quizAndDailyStatus_;
    }

    get isSearchCompleted() {
        return this.pcSearchStatus.isCompleted && this.mbSearchStatus.isCompleted;
    }

    get jobStatus() {
        return this._jobStatus_;
    }

    async update() {
        if (!this._updatePromise) {
            this._updatePromise = this._updateStatus().finally(() => {
                this._updatePromise = null;
            });
        }
        return this._updatePromise;
    }

    async _updateStatus() {
        this._jobStatus_ = STATUS_BUSY;
        try {
            await this.getMSRewardStatusFromBing();
            this._lastUpdateTime = Date.now();
            this._errMsg_ = null;
            this._jobStatus_ = STATUS_DONE;
            return true;
        } catch (error) {
            this._summary_.isValid = false;
            this._errMsg_ = error.message;
            this._jobStatus_ = STATUS_ERROR;
            console.error('DailyRewardStatus update failed:', error);
            throw error;
        }
    }

    async getMSRewardStatusFromBing() {
        this._parseUserStatus(await this.getUserStatusJson());
        return true;
    }

    async getUserStatusJson() {
        return DailyRewardStatus.getUserStatusJSON(await this._fetchText(USER_STATUS_BING_URL));
    }

    async getDetailedUserStatusJson() {
        return DailyRewardStatus.getUserStatusJSON(await this._fetchText(USER_STATUS_DETAILED_URL));
    }

    async _fetchText(url) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(url, {
                method: 'GET',
                credentials: 'include',
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new Error(`Rewards status request failed: HTTP ${response.status}`);
            }
            return await response.text();
        } finally {
            clearTimeout(timeout);
        }
    }

    _parseRewardsData(text) {
        this._parseUserStatus(DailyRewardStatus.getUserStatusJSON(text));
        return true;
    }

    _parseUserStatus(data) {
        if (data.IsError || data.IsRewardsUser === false) {
            throw new NotRewardUserException('Sign in to Microsoft Rewards and Bing, then retry.');
        }
        const flyout = data.FlyoutResult;
        const user = flyout?.UserStatus;
        const counters = user?.Counters;
        if (!Array.isArray(counters?.PCSearch) || counters.PCSearch.length === 0) {
            throw new Error('Rewards response is missing PC search counters. Sign in or check for an API change.');
        }

        const pc = this._createSearchStatus(counters.PCSearch, 'PCSearch');
        const mobile = this._createSearchStatus(counters.MobileSearch || [], 'MobileSearch');
        let activityRemaining = null;
        let activityEarned = null;
        let activityTotalsError = null;
        try {
            const activities = this._sumCounters(counters.ActivityAndQuiz || [], 'ActivityAndQuiz');
            const dailyPoints = this._sumCounters(getDailySetPromotions(flyout), 'DailySetPromotions');
            activityRemaining = activities.max - activities.progress + dailyPoints.max - dailyPoints.progress;
            activityEarned = activities.progress + dailyPoints.progress;
        } catch (error) {
            if (!(error instanceof ParseJSONFailedException)) throw error;
            activityTotalsError = error.message;
            console.warn('Rewards activity totals are unavailable; search counters remain valid:', error);
        }
        const searchPointsEarned = pc.pointsEarned + mobile.pointsEarned;
        const maxDailySearchPoints = pc.pointsMax + mobile.pointsMax;
        const availablePoints = activityRemaining === null ? null :
            Math.max(0, maxDailySearchPoints - searchPointsEarned + activityRemaining);

        this._pcSearchStatus_ = pc;
        this._mbSearchStatus_ = mobile;
        this._quizAndDailyStatus_ = {
            isCompleted: activityRemaining === 0,
            pointsToGet: activityRemaining === null ? null : Math.max(0, activityRemaining),
        };
        this._summary_ = {
            isValid: true,
            earnedToday: activityEarned === null ? null : searchPointsEarned + activityEarned,
            availablePoints,
            activityTotalsError,
            isCompleted: availablePoints === 0,
            searchPointsEarned,
            maxDailySearchPoints,
            lifetimePoints: user.LifetimePoints ?? null,
            balance: user.AvailablePoints ?? null,
        };
    }

    _sumCounters(counters, source) {
        if (!Array.isArray(counters)) {
            throw new ParseJSONFailedException(source, null, `Invalid Rewards counter list at ${source}.`);
        }
        return counters.reduce((total, counter, index) => {
            const max = counter?.PointProgressMax;
            const progress = counter?.Complete === true ? max : counter?.PointProgress;
            if (!Number.isFinite(max) || !Number.isFinite(progress) || max < 0 || progress < 0) {
                throw new ParseJSONFailedException(source, null,
                    `Invalid Rewards point counter at ${source}[${index}] ` +
                    `(PointProgress=${typeof counter?.PointProgress}, PointProgressMax=${typeof max}, Complete=${typeof counter?.Complete}).`);
            }
            return {progress: total.progress + Math.min(progress, max), max: total.max + max};
        }, {progress: 0, max: 0});
    }

    _createSearchStatus(counters, source = 'Search') {
        const {progress, max} = this._sumCounters(counters, source);
        const pointsPerSearch = counters[0]?.PointProgressStep ?? 5;
        if (!Number.isFinite(pointsPerSearch) || pointsPerSearch <= 0) {
            throw new Error('Invalid points-per-search value in Rewards response.');
        }
        const isValid = max > 0;
        const isCompleted = progress >= max;
        return {
            isValid,
            isCompleted,
            isValidAndCompleted: isValid && isCompleted,
            progress: progress / pointsPerSearch,
            progressMax: Math.ceil(max / pointsPerSearch),
            pointsPerSearch,
            pointsEarned: progress,
            pointsMax: max,
            searchNeededCount: Math.ceil((max - progress) / pointsPerSearch),
        };
    }

    getStatusSummary() {
        return {
            ...this.summary,
            pcSearchStatus: this.pcSearchStatus,
            mbSearchStatus: this.mbSearchStatus,
        };
    }

    async getLifetimePoints() {
        if (!this.summary.isValid) await this.update();
        return this.summary.lifetimePoints;
    }

    static getUserStatusJSON(text) {
        const trimmed = text.trim();
        if (trimmed.startsWith('{')) {
            return JSON.parse(trimmed);
        }
        const match = /\{\s*"(?:FlyoutConfig|userStatus)"\s*:/.exec(text);
        if (!match) throw new Error('Rewards data was not found. Sign in to Microsoft Rewards and Bing.');

        // Extract the JSON object without depending on script suffixes or one-line HTML.
        let depth = 0;
        let quoted = false;
        let escaped = false;
        for (let i = match.index; i < text.length; i++) {
            const character = text[i];
            if (quoted) {
                if (escaped) escaped = false;
                else if (character === '\\') escaped = true;
                else if (character === '"') quoted = false;
            } else if (character === '"') {
                quoted = true;
            } else if (character === '{') {
                depth++;
            } else if (character === '}' && --depth === 0) {
                return JSON.parse(text.slice(match.index, i + 1));
            }
        }
        throw new Error('Rewards returned incomplete JSON data.');
    }
}

const STATUS_NONE = 0;
const STATUS_DONE = 20;
const STATUS_ERROR = 3;

const USER_STATUS_BING_URL = 'https://www.bing.com/rewardsapp/flyout?channel=0';
const USER_STATUS_DETAILED_URL = 'https://rewards.bing.com/';
