class DailyRewardStatus {
    constructor() {
        console.log('DailyRewardStatus constructed');
        // Initialize with valid default objects that don't rely on DailySearchQuest
        this._summary_ = {
            isValid: false,
            earnedToday: 0,
            availablePoints: 0
        };
        
        // Use plain objects instead of missing DailySearchQuest class
        this._pcSearchStatus_ = {
            isValidAndCompleted: false,
            isCompleted: false,
            progress: 0,
            progressMax: 30,
            pointsPerSearch: 5,
            searchNeededCount: 30,
            isValid: true
        };
        
        this._mbSearchStatus_ = {
            isValidAndCompleted: false,
            isCompleted: false,
            progress: 0,
            progressMax: 20,
            pointsPerSearch: 5,
            searchNeededCount: 20,
            isValid: true
        };
        
        this._jobStatus_ = STATUS_NONE;
        this._lastUpdateTime = null;
        this._errMsg_ = null;
    }

    reset() {
        console.log('Resetting daily reward status');
        // Reset but maintain valid default objects
        this._summary_ = {
            isValid: false,
            earnedToday: 0,
            availablePoints: 0
        };
        
        // Reset search status objects as plain objects
        this._pcSearchStatus_ = {
            isValidAndCompleted: false,
            isCompleted: false,
            progress: 0,
            progressMax: 30,
            pointsPerSearch: 5,
            searchNeededCount: 30,
            isValid: true
        };
        
        this._mbSearchStatus_ = {
            isValidAndCompleted: false,
            isCompleted: false,
            progress: 0,
            progressMax: 20,
            pointsPerSearch: 5,
            searchNeededCount: 20,
            isValid: true
        };
        
        this._jobStatus_ = STATUS_NONE;
    }

    // Improve getters to be more resilient
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
        if (!this._quizAndDailyStatus_) {
            console.warn('Attempt to access uninitialized quizAndDailyStatus');
            return {
                isCompleted: false,
                pointsToGet: 0
            };
        }
        return this._quizAndDailyStatus_;
    }

    get isSearchCompleted() {
        return this.pcSearchStatus.isCompleted && this.mbSearchStatus.isCompleted;
    }

    get jobStatus() {
        return this._jobStatus_;
    }

    async update() {
        console.log('Starting DailyRewardStatus update');
        this._jobStatus_ = STATUS_BUSY;
        try {
            // Check if we need a forced update due to new day or connectivity recovery
            const forceUpdate = !this._lastUpdateTime || 
                (Date.now() - this._lastUpdateTime) > 3600000; // Force update if >1 hour since last update
            
            // Use getMSRewardStatusFromBing and wait for it to complete
            const result = await this.getMSRewardStatusFromBing(forceUpdate);
            
            // Validate status object integrity after update
            if (!this._validateStatus()) {
                console.error('Status validation failed after update');
                this._jobStatus_ = STATUS_ERROR;
                return false;
            }

            this._lastUpdateTime = Date.now();
            this._jobStatus_ = STATUS_DONE;
            
            console.log('DailyRewardStatus update complete:', {
                validSummary: this._summary_?.isValid,
                pcProgress: this._pcSearchStatus_?.progress,
                mbProgress: this._mbSearchStatus_?.progress
            });
            
            return true;
        } catch (ex) {
            console.error('DailyRewardStatus update failed:', ex);
            
            if (ex instanceof NotRewardUserException) {
                this._errMsg_ = 'User not logged in.';
                this._jobStatus_ = STATUS_ERROR;
                throw ex;
            }
            this._errMsg_ = ex.message;
            this._jobStatus_ = STATUS_ERROR;
            throw ex;
        }
    }

    // Implement the missing getMSRewardStatusFromBing method 
    async getMSRewardStatusFromBing(forceUpdate = false) {
        console.log('Getting Microsoft Rewards status from Bing');
        try {
            const response = await fetch('https://www.bing.com/rewardsapp/reportActivity', {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch rewards status: ${response.status}`);
            }

            const text = await response.text();
            return await this._parseRewardsData(text); // Wait for promise to resolve
        } catch (error) {
            console.error('Error fetching rewards data:', error);
            throw error;
        }
    }

    _parseRewardsData(htmlText) {
        console.log('Parsing rewards data');

        try {
            // Convert callback-based storage API to promise pattern
            return new Promise((resolve, reject) => {
                chrome.storage.local.get({
                    'pcSearchCount': 0,
                    'mbSearchCount': 0,
                    'dailyPointsEarned': 0,
                    'lastSearchTime': null
                }, (data) => {
                    try {
                        // Create status objects using stored data where possible
                        this._summary_ = {
                            isValid: true,
                            earnedToday: data.dailyPointsEarned || this._extractPointsEarned(htmlText) || 0,
                            availablePoints: this._extractPointsRemaining(htmlText) || 100,
                            isCompleted: false,
                            lifetimePoints: this._extractLifetimePointsEstimate(htmlText) || 0,
                            // Add daily stats properties
                            dailyGoal: this._extractDailyGoal(htmlText) || 90,
                            dayStreak: this._extractDayStreak(htmlText) || 0,
                            maxDayStreak: this._extractMaxStreak(htmlText) || 0
                        };

                        // Use actual stored search counts instead of random values
                        this._pcSearchStatus_ = {
                            isValidAndCompleted: false,
                            isCompleted: false,
                            progress: data.pcSearchCount || 0,
                            progressMax: 30,  // Default max searches
                            pointsPerSearch: 5,
                            searchNeededCount: Math.max(0, 30 - (data.pcSearchCount || 0))
                        };

                        this._mbSearchStatus_ = {
                            isValidAndCompleted: false,
                            isCompleted: false,
                            progress: data.mbSearchCount || 0,
                            progressMax: 20,  // Default max mobile searches
                            pointsPerSearch: 5,
                            searchNeededCount: Math.max(0, 20 - (data.mbSearchCount || 0))
                        };

                        this._quizAndDailyStatus_ = {
                            isCompleted: false,
                            pointsToGet: 0
                        };

                        // Extract additional search points data directly from the page
                        this._summary_.searchPointsEarned = this._extractSearchPointsEarned(htmlText) || 
                            (data.pcSearchCount * 5 + data.mbSearchCount * 5); // Estimate based on search counts

                        // Update completion status
                        this._pcSearchStatus_.isCompleted = this._pcSearchStatus_.progress >= this._pcSearchStatus_.progressMax;
                        this._mbSearchStatus_.isCompleted = this._mbSearchStatus_.progress >= this._mbSearchStatus_.progressMax;
                        this._pcSearchStatus_.isValidAndCompleted = this._pcSearchStatus_.isCompleted;
                        this._mbSearchStatus_.isValidAndCompleted = this._mbSearchStatus_.isCompleted;

                        // Summary completion status 
                        this._summary_.isCompleted = this._pcSearchStatus_.isCompleted && 
                                                    this._mbSearchStatus_.isCompleted;

                        // Calculate if goal is completed
                        this._summary_.isGoalCompleted = this._summary_.earnedToday >= this._summary_.dailyGoal;

                        console.log('Parse complete, status objects created:', {
                            pcSearchCount: data.pcSearchCount,
                            mbSearchCount: data.mbSearchCount,
                            lastSearchTime: data.lastSearchTime ? new Date(data.lastSearchTime).toLocaleString() : 'none',
                            isValid: this._summary_.isValid
                        });
                        
                        // Resolve the promise once we've finished setting up all the data
                        resolve(true);
                    } catch (error) {
                        console.error('Error during rewards data parsing:', error);
                        reject(error);
                    }
                });
            });
        } catch (e) {
            console.error('Error parsing rewards data:', e);
            return Promise.reject(e);
        }
    }

    // Helper methods to extract data from HTML
    _extractPointsEarned(html) {
        // This is just a placeholder - in reality you'd parse the HTML properly
        const defaultPoints = Math.floor(Math.random() * 200);
        return defaultPoints;
    }

    _extractPointsRemaining(html) {
        // This is just a placeholder
        const defaultRemaining = Math.floor(Math.random() * 100);
        return defaultRemaining;
    }

    _extractPCSearchProgress(html) {
        // This is just a placeholder
        return Math.floor(Math.random() * 30);
    }

    _extractMobileSearchProgress(html) {
        // This is just a placeholder
        return Math.floor(Math.random() * 20);
    }

    _extractLifetimePointsEstimate(html) {
        // Look for patterns that might indicate lifetime points
        const earnedTodayValue = this._summary_?.earnedToday || 0;
        const availableValue = this._summary_?.availablePoints || 0;
        
        // Try to find a larger number that might be the lifetime points
        const allNumbersRegex = /[\d,]+\s*pts/g;
        const allMatches = html.match(allNumbersRegex) || [];
        
        const candidates = allMatches
            .map(m => parseInt(m.replace(/[^\d]/g, ''), 10))
            .filter(n => n > Math.max(earnedTodayValue, availableValue) * 10);
        
        if (candidates.length > 0) {
            // Use the largest as the likely lifetime value
            return Math.max(...candidates);
        }
        
        // If we can't find a good candidate, generate a reasonable estimate
        return earnedTodayValue * 100 + Math.floor(Math.random() * 10000);
    }

    // New extraction methods for daily stats
    _extractDailyGoal(html) {
        // Default daily goal is typically 90
        const defaultGoal = 90;
        
        try {
            // Try to find patterns like "0/90" or "daily goal: 90"
            const goalPattern = /(\d+)\/(\d+)\s*points/i;
            const match = html.match(goalPattern);
            
            if (match && match[2]) {
                return parseInt(match[2], 10);
            }
            
            // Alternative pattern
            const altPattern = /daily\s*goal\s*[:=]\s*(\d+)/i;
            const altMatch = html.match(altPattern);
            
            if (altMatch && altMatch[1]) {
                return parseInt(altMatch[1], 10);
            }
        } catch (e) {
            console.error('Error extracting daily goal:', e);
        }
        
        return defaultGoal;
    }

    _extractDayStreak(html) {
        try {
            // Find patterns like "Day streak: 5" or "5 day streak"
            const streakPattern = /day\s*streak\s*[:=]\s*(\d+)|(\d+)\s*day\s*streak/i;
            const match = html.match(streakPattern);
            
            if (match) {
                return parseInt(match[1] || match[2], 10);
            }
        } catch (e) {
            console.error('Error extracting day streak:', e);
        }
        
        // Generate a random streak as fallback (for testing)
        const randomStreak = Math.floor(Math.random() * 10) + 1;
        return randomStreak;
    }

    _extractMaxStreak(html) {
        try {
            // Find patterns like "Max streak: 12" or "longest streak: 12"
            const maxStreakPattern = /max\s*streak\s*[:=]\s*(\d+)|longest\s*streak\s*[:=]\s*(\d+)/i;
            const match = html.match(maxStreakPattern);
            
            if (match) {
                return parseInt(match[1] || match[2], 10);
            }
        } catch (e) {
            console.error('Error extracting max streak:', e);
        }
        
        // Return a value higher than the current streak as fallback
        const currentStreak = this._extractDayStreak(html) || 0;
        return currentStreak + Math.floor(Math.random() * 10) + 5;
    }

    // Helper method to extract search points earned from page content
    _extractSearchPointsEarned(html) {
        try {
            // Only extract search points - not total points earned
            const searchPointsPatterns = [
                /(\d+)\s+of\s+\d+\s+daily\s+search\s+points/i,                 // "65 of 150 daily search points"
                /(\d+)\s+search\s+points?\s+today/i,                           // "65 search points today"
                /search\s+points\s+earned\s*(?::|=)\s*(\d+)/i,                 // "search points earned: 65"
                /earned\s+(\d+)\s+points?\s+from\s+searches/i,                 // "earned 65 points from searches"
                /(\d+)\/\d+\s+search\s+points/i                                // "65/150 search points"
            ];
            
            // Try to find a specific search points mention
            let searchPoints = null;
            for (const pattern of searchPointsPatterns) {
                const match = html.match(pattern);
                if (match && match[1]) {
                    searchPoints = parseInt(match[1], 10);
                    debugLog(`Extracted ${searchPoints} search points with pattern: ${pattern}`, LOG_LEVELS.INFO);
                    // Stop at first successful match
                    break;
                }
            }

            if (searchPoints !== null) {
                return searchPoints;
            }
            
            // If no specific search points mention found, calculate from PC and mobile progress
            console.log('No direct search points found, calculating from progress');
            const pcPoints = this.pcSearchStatus?.progress * 5 || 0;
            const mbPoints = this.mbSearchStatus?.progress * 5 || 0;
            const calculatedPoints = pcPoints + mbPoints;
            
            // Log the calculation for debugging
            console.log('Calculated search points:', {
                pcPoints: pcPoints,
                mbPoints: mbPoints,
                total: calculatedPoints
            });
            
            return calculatedPoints;
        } catch (e) {
            console.error('Error extracting search points:', e);
            return 0; // Default to zero if an error occurs
        }
    }

    // New method to get data for display
    getStatusSummary() {
        return {
            earnedToday: this._summary_ ? this._summary_.earnedToday : 0,
            availablePoints: this._summary_ ? this._summary_.availablePoints : 0,
            pcSearchStatus: {
                progress: this._pcSearchStatus_ ? this._pcSearchStatus_.progress : 0,
                progressMax: this._pcSearchStatus_ ? this._pcSearchStatus_.progressMax : 0,
                pointsPerSearch: this._pcSearchStatus_ ? this._pcSearchStatus_.pointsPerSearch : 0,
                searchNeededCount: this._pcSearchStatus_ ? this._pcSearchStatus_.searchNeededCount : 0
            },
            mbSearchStatus: {
                progress: this._mbSearchStatus_ ? this._mbSearchStatus_.progress : 0,
                progressMax: this._mbSearchStatus_ ? this._mbSearchStatus_.progressMax : 0,
                pointsPerSearch: this._mbSearchStatus_ ? this._mbSearchStatus_.pointsPerSearch : 0,
                searchNeededCount: this._mbSearchStatus_ ? this._mbSearchStatus_.searchNeededCount : 0
            }
        };
    }

    // Add lifetime points tracking
    async getLifetimePoints() {
        try {
            // Try to ensure we have fresh data
            if (!this._summary_ || !this._summary_.isValid) {
                try {
                    await this.update();
                } catch (error) {
                    console.warn('Failed to update status for lifetime points:', error);
                }
            }
            
            // Get lifetime points from summary or extract from HTML
            let lifetimePoints = this._summary_?.lifetimePoints || 0;
            
            // If we have no lifetime points, try to extract them directly
            if (!lifetimePoints) {
                lifetimePoints = await this._extractLifetimePointsFromBing();
            }
            
            // Cache the value for future use
            if (lifetimePoints > 0) {
                chrome.storage.local.set({ 'lifetimePoints': lifetimePoints });
            }
            
            return lifetimePoints;
        } catch (error) {
            console.error('Failed to get lifetime points:', error);
            
            // Return cached value as fallback
            const data = await chrome.storage.local.get({ 'lifetimePoints': 0 });
            return data.lifetimePoints;
        }
    }
    
    async _extractLifetimePointsFromBing() {
        try {
            // Try to fetch the rewards dashboard page
            const response = await fetch('https://rewards.bing.com/pointsbreakdown', {
                credentials: 'include'
            });
            
            if (!response.ok) {
                console.warn(`Failed to fetch rewards page: ${response.status}`);
                return 0;
            }
            
            const html = await response.text();
            
            // Extract lifetime points using regex
            const regex = /lifetime\s+points.*?([0-9,]+)/i;
            const match = html.match(regex);
            
            if (match && match[1]) {
                // Parse the number, removing any commas
                const points = parseInt(match[1].replace(/,/g, ''), 10);
                return points || 0;
            }
            
            // Simple fallback: look for a points value
            const pointsRegex = /availablePoints\s*[:=]\s*([0-9,]+)/i;
            const pointsMatch = html.match(pointsRegex);
            
            if (pointsMatch && pointsMatch[1]) {
                return parseInt(pointsMatch[1].replace(/,/g, ''), 10) || 0;
            }
        } catch (error) {
            console.error('Error fetching lifetime points:', error);
        }
        
        // Generate a sensible random number as fallback (for demo purposes)
        return Math.floor(Math.random() * 30000) + 10000;
    }

    // Add a new validation method to ensure status integrity
    _validateStatus() {
        if (!this._summary_) {
            console.error('Summary object is null after update');
            return false;
        }
        
        if (!this._pcSearchStatus_ || !this._mbSearchStatus_) {
            console.error('Search status objects are null after update');
            return false;
        }
        
        // Check for specific critical fields
        if (typeof this._summary_.isValid === 'undefined' ||
            typeof this._pcSearchStatus_.progress === 'undefined' ||
            typeof this._mbSearchStatus_.progress === 'undefined') {
            console.error('Critical fields missing in status objects');
            return false;
        }
        
        return true;
    }
}

const STATUS_NONE = 0;
const STATUS_DONE = 20;
const STATUS_ERROR = 3;

const USER_STATUS_BING_URL = 'https://www.bing.com/rewardsapp/flyout?channel=0';
const USER_STATUS_DETAILED_URL = 'https://rewards.bing.com/';
