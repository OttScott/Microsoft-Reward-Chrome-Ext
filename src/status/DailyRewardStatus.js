class DailyRewardStatus {
    constructor() {
        this.reset();
    }

    reset() {
        this._status = {
            jobStatus: STATUS_NONE,
            summary: {
                isValid: false,
                isCompleted: false
            },
            pcSearchStatus: {
                progress: 0,
                max: 0,
                isCompleted: false,
                searchNeededCount: 0
            },
            mbSearchStatus: {
                progress: 0,
                max: 0,
                isCompleted: false,
                searchNeededCount: 0
            }
        };
    }

    get jobStatus() {
        return this._status.jobStatus;
    }

    get summary() {
        return this._status.summary;
    }

    get pcSearchStatus() {
        return this._status.pcSearchStatus;
    }

    get mbSearchStatus() {
        return this._status.mbSearchStatus;
    }

    get isSearchCompleted() {
        return this.pcSearchStatus.isCompleted && this.mbSearchStatus.isCompleted;
    }

    async getUserStatusJson() {
        console.log('Checking Microsoft Rewards status...');
        try {
            const response = await fetch('https://rewards.microsoft.com/', {
                method: 'GET',
                credentials: 'include',
                headers: {
                    'Accept': 'text/html',
                    'Cache-Control': 'no-cache'
                }
            });

            console.log('Login check response:', {
                status: response.status,
                url: response.url
            });

            // If we get redirected to login or get a 401, user needs to sign in
            if (response.url.includes('login.live.com') || response.status === 401) {
                console.warn('User needs to sign in at rewards.microsoft.com');
                return {
                    IsError: true,
                    IsRewardsUser: false,
                    Message: 'Please sign in at rewards.microsoft.com first'
                };
            }

            // For now, just return a dummy successful response
            return {
                IsError: false,
                IsRewardsUser: true,
                FlyoutResult: {
                    UserStatus: {
                        Counters: {
                            PCSearch: [{ PointProgress: 0, PointProgressMax: 150 }],
                            MobileSearch: [{ PointProgress: 0, PointProgressMax: 100 }]
                        }
                    }
                }
            };

        } catch (error) {
            console.error('Login check failed:', error);
            return {
                IsError: true,
                IsRewardsUser: false,
                Message: 'Please check your internet connection'
            };
        }
    }

    async _tryFetchStatus(url) {
        return fetch(url, {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Accept': 'application/json',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Referer': url,
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin'
            }
        });
    }

    async update() {
        try {
            console.log('Updating daily reward status...');
            const statusJson = await this.getUserStatusJson();
            
            if (!statusJson || statusJson.IsError) {
                console.warn('Invalid status response:', statusJson);
                setBadge(new WarningBadge());
                return STATUS_ERROR;
            }

            if (!statusJson.IsRewardsUser) {
                console.warn('User not logged in to Microsoft Rewards');
                setBadge(new WarningBadge());
                // Don't throw error, just return error status
                return STATUS_ERROR;
            }

            // Process status data...
            this._updateFromJson(statusJson);
            return STATUS_DONE;

        } catch (error) {
            console.error('Failed to update status:', error);
            setBadge(new ErrorBadge());
            return STATUS_ERROR;
        }
    }

    _updateFromJson(statusJson) {
        const pcProgress = statusJson.FlyoutResult.UserStatus.Counters.PCSearch[0];
        const mbProgress = statusJson.FlyoutResult.UserStatus.Counters.MobileSearch[0];

        this._status.pcSearchStatus.progress = pcProgress.PointProgress;
        this._status.pcSearchStatus.max = pcProgress.PointProgressMax;
        this._status.pcSearchStatus.isCompleted = pcProgress.PointProgress >= pcProgress.PointProgressMax;
        this._status.pcSearchStatus.searchNeededCount = Math.ceil((pcProgress.PointProgressMax - pcProgress.PointProgress) / pcProgress.PointsPerSearch);

        this._status.mbSearchStatus.progress = mbProgress.PointProgress;
        this._status.mbSearchStatus.max = mbProgress.PointProgressMax;
        this._status.mbSearchStatus.isCompleted = mbProgress.PointProgress >= mbProgress.PointProgressMax;
        this._status.mbSearchStatus.searchNeededCount = Math.ceil((mbProgress.PointProgressMax - mbProgress.PointProgress) / mbProgress.PointsPerSearch);

        this._status.summary.isValid = true;
        this._status.summary.isCompleted = this.isSearchCompleted;

        console.log('Status updated successfully:', this._status);
    }
}

const STATUS_NONE = 0;
const STATUS_DONE = 20;
const STATUS_ERROR = 3;

const USER_STATUS_BING_URL = 'https://www.bing.com/rewardsapp/flyout?channel=0';
const USER_STATUS_DETAILED_URL = 'https://rewards.bing.com/';
