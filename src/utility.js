const DEBUG = true;
const LOG_LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3,
    VERBOSE: 4
};

let currentLogLevel = LOG_LEVELS.INFO; // Default log level

function setLogLevel(level) {
    currentLogLevel = level;
    debugLog(`Log level set to: ${Object.keys(LOG_LEVELS)[level]}`);
}

function debugLog(message, level = LOG_LEVELS.INFO, ...args) {
    if (!DEBUG || level > currentLogLevel) return;

    const timestamp = new Date().toISOString();
    const levelName = Object.keys(LOG_LEVELS)[level];
    
    if (typeof message === 'object') {
        console.log(`${timestamp} [${levelName}]`, message, ...args);
    } else {
        console.log(`${timestamp} [${levelName}] ${message}`, ...args);
    }
}

let _prevWeekDay = -1;

function checkNewDay() {
    const currentDate = new Date().toLocaleDateString();
    
    chrome.storage.local.get({lastRunDate: ''}, function(data) {
        // Check if it's a new day or if lastRunDate is not set
        if (data.lastRunDate !== currentDate) {
            debugLog(`New day detected! Previous: ${data.lastRunDate}, Current: ${currentDate}`, LOG_LEVELS.INFO);
            
            // Update the last run date
            chrome.storage.local.set({lastRunDate: currentDate});
            
            // Reset search state and counters
            resetDailyCounters();
            
            // Force a full status refresh on new day
            chrome.runtime.sendMessage({
                action: 'newDay'
            }).catch(err => {
                // Ignore error if no listeners
                debugLog('No listeners for newDay event', LOG_LEVELS.DEBUG);
            });
        }
    });
}

function resetDailyCounters() {
    debugLog('Resetting daily counters and search state', LOG_LEVELS.INFO);
    
    // Reset local storage values related to daily state
    chrome.storage.local.set({
        'dailySearchComplete': false,
        'pcSearchCount': 0,
        'mbSearchCount': 0,
        'lastSearchTime': null,
        'googleTrendDate': null,  // Force refresh of search terms
        'targetSearchCount': null, // Force recalculation of search counts
        'dailyPointsEarned': 0,   // Reset points earned counter
        'searchesUpdatedOn': new Date().toISOString(), // Add timestamp of when searches were reset
        'searchPausedAt': null,   // Clear any paused state
        'pausedSearchCount': 0,
        'pausedSearchType': null,
        'searchPausedReason': null
    }, () => {
        debugLog('Local storage counters reset', LOG_LEVELS.INFO);
    });
    
    // Reset the UI if the popup is open
    chrome.runtime.sendMessage({
        action: 'resetCounters'
    }).catch(() => {
        // Ignore errors if popup isn't open
    });
}

// Update or add the connectivity check function

async function checkInternetConnectivity() {
    try {
        // Use direct ping to common services with a direct ping method
        // This avoids CORS issues entirely
        
        // Always check navigator.onLine first
        if (!navigator.onLine) {
            debugLog('Browser reports device is offline', LOG_LEVELS.WARN);
            return false;
        }
        
        // Try multiple ping approaches
        const ping1 = await pingEndpoint('https://www.bing.com/');
        if (ping1) {
            debugLog('Internet connectivity verified via Bing', LOG_LEVELS.DEBUG);
            return true;
        }
        
        const ping2 = await pingEndpoint('https://www.microsoft.com/');
        if (ping2) {
            debugLog('Internet connectivity verified via Microsoft', LOG_LEVELS.DEBUG);
            return true;
        }
        
        // Last resort - try an image fetch which is less likely to hit CORS issues
        try {
            const imgTest = await fetch('https://www.bing.com/favicon.ico', { 
                method: 'HEAD',
                cache: 'no-store',
                // No mode: 'no-cors' as it makes response status unreadable
                timeout: 5000
            });
            
            if (imgTest.ok) {
                debugLog('Internet connectivity verified via favicon', LOG_LEVELS.DEBUG);
                return true;
            }
        } catch (imgErr) {
            debugLog('Favicon connectivity test failed', LOG_LEVELS.DEBUG);
        }
        
        // If navigator.onLine is true but all tests failed, give benefit of doubt
        // This helps in environments where network requests might be blocked
        if (navigator.onLine) {
            debugLog('All connectivity tests failed, but browser reports online - assuming connected', LOG_LEVELS.WARN);
            return true;
        }
        
        debugLog('Internet connectivity check failed - device appears to be offline', LOG_LEVELS.WARN);
        return false;
    } catch (error) {
        debugLog('Error in internet connectivity check:', LOG_LEVELS.ERROR, error);
        // Default to browser's online status as fallback
        return navigator.onLine;
    }
}

// Helper function to ping a single endpoint
async function pingEndpoint(url) {
    try {
        // Use a simple HEAD request with short timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const response = await fetch(url, {
            method: 'HEAD',
            cache: 'no-store',
            // No CORS mode specified - we want to know if it fails
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        return response.ok;
    } catch (error) {
        // Any error means the ping failed
        return false;
    }
}

function isNewDay() {
    let day;
    if ((day = new Date().getDay()) != _prevWeekDay) {
        _prevWeekDay = day;
        return true;
    }
    return false;
}

function getDomFromText(text) {
    return new DOMParser().parseFromString(text, 'text/html');
}

function getTodayDate() {
    const today = new Date();
    let dd = today.getDate();
    let mm = today.getMonth() + 1;
    if (dd < 10) {
        dd = '0' + dd;
    }
    if (mm < 10) {
        mm = '0' + mm;
    }
    return `${mm}/${today.getFullYear()}`;
}

function resetDayBoundParams() {
    searchQuest.reset();
    googleTrend.reset();
}

function isHttpUrlValid(url) {
    // rule:
    // starts with https:// or http://
    // followed by non-whitespace character
    // must end with a word character, a digit, or close bracket (')') with or without forward slash ('/')
    return /^https?:\/\/\S+.*\..*[\w\d]+\)?\/?$/i.test(url);
}

function getElementByXpath(path, element) {
    return document.evaluate(path, element, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
}

async function copyTextToClipboard(text) {
    // Credit: https://stackoverflow.com/a/18455088/1786137
    // Create a textbox field where we can insert text to.
    const copyFrom = document.createElement('textarea');

    // Set the text content to be the text you wished to copy.
    copyFrom.textContent = text;

    // Append the textbox field into the body as a child.
    // "execCommand()" only works when there exists selected text, and the text is inside
    // document.body (meaning the text is part of a valid rendered HTML element).
    document.body.appendChild(copyFrom);

    // Select all the text!
    copyFrom.select();

    // Execute command
    document.execCommand('copy');

    // (Optional) De-select the text using blur().
    copyFrom.blur();

    // Remove the textbox field from the document.body, so no other JavaScript nor
    // other elements can get access to this.
    document.body.removeChild(copyFrom);
}

async function getDebugInfo() {
    let text = '[';
    debugLog('Collecting debug info...', LOG_LEVELS.DEBUG);

    await userDailyStatus.getUserStatusJson().then(
        (statusJson) => {
            debugLog('Retrieved user status JSON:', LOG_LEVELS.DEBUG, statusJson);
            info = {
                'IsError': statusJson.IsError,
                'IsRewardsUser': statusJson.IsRewardsUser,
                'FlyoutResult': {
                    'DailySetPromotions': statusJson.FlyoutResult.DailySetPromotions,
                    'MorePromotions': statusJson.FlyoutResult.MorePromotions,
                },
                'UserStatus': {
                    'Counters': statusJson.FlyoutResult.UserStatus.Counters,
                },
            };
            text += JSON.stringify(info);
        },
    ).catch((ex) => {
        debugLog('Error getting user status:', LOG_LEVELS.ERROR, ex);
        text += '"' + ex.message + '"';
    });

    await userDailyStatus.getDetailedUserStatusJson().then(
        (statusJson) => {
            debugLog('Retrieved detailed status JSON:', LOG_LEVELS.DEBUG, statusJson);
            info = {
                'punchCards': statusJson.punchCards,
            };
            text += ',' + JSON.stringify(info);
        },
    ).catch((ex) => {
        debugLog('Error getting detailed status:', LOG_LEVELS.ERROR, ex);
        text += ',"' + ex.message + '"';
    });

    text += ']';
    debugLog('Debug info collected:', LOG_LEVELS.DEBUG, text);
    copyTextToClipboard(text);
}

async function getUA() {
    debugLog('Getting user agents...', LOG_LEVELS.DEBUG);
    try {
        // First check if we have user agent overrides
        if (_pcUaOverrideEnable && _mbUaOverrideEnable) {
            userAgents = {
                'pc': _pcUaOverrideValue,
                'mb': _mbUaOverrideValue,
                'pcSource': 'override',
                'mbSource': 'override',
            };
            assertUA();
            return;
        }
        
        // Check if we have fallback UAs in local storage
        const fallbacks = await chrome.storage.local.get({
            'fallbackPcUA': null,
            'fallbackMbUA': null,
            'lastFallbackUpdate': null
        });
        
        // If we have valid fallbacks that are recent (within last 7 days), use them first
        if (fallbacks.fallbackPcUA && fallbacks.fallbackMbUA && fallbacks.lastFallbackUpdate) {
            const lastUpdate = new Date(fallbacks.lastFallbackUpdate);
            const now = new Date();
            const daysDiff = (now - lastUpdate) / (1000 * 60 * 60 * 24);
            
            if (daysDiff < 7) {
                debugLog('Using recent fallback UAs from storage', LOG_LEVELS.INFO);
                userAgents = {
                    'pc': fallbacks.fallbackPcUA,
                    'mb': fallbacks.fallbackMbUA,
                    'pcSource': 'fallback',
                    'mbSource': 'fallback',
                };
                
                // Apply overrides if defined
                if (_pcUaOverrideEnable) {
                    userAgents.pc = _pcUaOverrideValue;
                    userAgents.pcSource = 'override';
                }
                
                if (_mbUaOverrideEnable) {
                    userAgents.mb = _mbUaOverrideValue;
                    userAgents.mbSource = 'override';
                }
                
                assertUA();
                
                // Try to update in background but don't wait for it
                getStableUA().catch(err => {
                    debugLog('Background update of stable UAs failed:', LOG_LEVELS.WARN, err);
                });
                
                return;
            }
        }
        
        // Try to get stable UAs
        await getStableUA();
        
        // Apply overrides if defined
        if (_pcUaOverrideEnable) {
            userAgents.pc = _pcUaOverrideValue;
            userAgents.pcSource = 'override';
        }
        
        if (_mbUaOverrideEnable) {
            userAgents.mb = _mbUaOverrideValue;
            userAgents.mbSource = 'override';
        }
        
        assertUA();
    } catch (error) {
        console.error('Failed to get stable UAs, trying fallbacks:', error);
        await loadFallbackUserAgents();
    }
}

// New function to load fallback UAs from storage
async function loadFallbackUserAgents() {
    debugLog('Loading fallback user agents from storage...', LOG_LEVELS.INFO);
    
    try {
        const data = await chrome.storage.local.get({
            'fallbackPcUA': null,
            'fallbackMbUA': null
        });
        
        // Initialize user agents if we don't have them yet
        if (!userAgents) {
            userAgents = {
                'pcSource': 'fallback',
                'mbSource': 'fallback'
            };
        }
        
        // If we have stored fallbacks, use them
        if (data.fallbackPcUA) {
            userAgents.pc = data.fallbackPcUA;
            userAgents.pcSource = 'fallback';
            debugLog('Using fallback PC UA from storage', LOG_LEVELS.INFO);
        } else {
            // Default fallback PC UA
            userAgents.pc = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0';
        }
        
        if (data.fallbackMbUA) {
            userAgents.mb = data.fallbackMbUA;
            userAgents.mbSource = 'fallback';
            debugLog('Using fallback Mobile UA from storage', LOG_LEVELS.INFO);
        } else {
            // Default fallback Mobile UA
            userAgents.mb = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
        }
        
        // Store these values even if they're the default ones
        if (!data.fallbackPcUA || !data.fallbackMbUA) {
            chrome.storage.local.set({
                'fallbackPcUA': userAgents.pc,
                'fallbackMbUA': userAgents.mb,
                'lastFallbackUpdate': new Date().toISOString()
            });
        }
        
        assertUA();
        return true;
    } catch (error) {
        console.error('Failed to load fallback UAs:', error);
        
        // Last resort - hardcoded UAs
        userAgents = {
            pc: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
            mb: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
            pcSource: 'hardcoded',
            mbSource: 'hardcoded'
        };
        
        debugLog('Using hardcoded fallback UAs', LOG_LEVELS.WARN);
        
        try {
            assertUA();
            return true;
        } catch (assertError) {
            console.error('Even hardcoded UAs failed validation:', assertError);
            throw new UserAgentInvalidException('No working user agents available');
        }
    }
}

async function getStableUA() {
    debugLog('Fetching stable user agents...', LOG_LEVELS.DEBUG);
    const controller = new AbortController();
    const signal = controller.signal;
    const url = 'https://raw.githubusercontent.com/tmxkn1/Microsoft-Reward-Chrome-Ext/master/useragents.json';
    
    try {
        const fetchProm = fetch(url, {method: 'GET', signal: signal});
        setTimeout(() => controller.abort(), 3000);

        const response = await fetchProm;
        debugLog('Stable UA fetch response:', LOG_LEVELS.DEBUG, response.status, response.statusText);

        if (!response.ok) {
            const errorText = await response.text();
            debugLog('Stable UA fetch failed:', LOG_LEVELS.ERROR, errorText);
            throw new Error(errorText);
        }

        const text = await response.text();
        const ua = JSON.parse(text);
        userAgents = {
            'pc': ua.stable.edge_win,
            'mb': ua.stable.chrome_ios,
            'pcSource': 'stable',
            'mbSource': 'stable',
        };
    } catch (ex) {
        debugLog('Stable UA fetch error:', LOG_LEVELS.ERROR, {
            name: ex.name,
            message: ex.message,
            stack: ex.stack
        });
        
        // First try to load fallbacks before giving up
        try {
            await loadFallbackUserAgents();
            return;
        } catch (fallbackError) {
            debugLog('Failed to load fallbacks after stable UA fetch failed', LOG_LEVELS.ERROR);
        }
        
        if (ex.name === 'AbortError') {
            throw new FetchFailedException('getStableUA', ex, 'Fetch timed out. Failed to update user agents. Perhaps, Github server is offline.');
        }
        throw new FetchFailedException('getStableUA', ex);
    }
}

async function getUpdatedUA(type='both') {
    debugLog('Fetching updated user agents for type:', LOG_LEVELS.DEBUG, type);
    const controller = new AbortController();
    const signal = controller.signal;
    const url = 'https://raw.githubusercontent.com/tmxkn1/UpdatedUserAgents/master/useragents.json';
    
    try {
        const fetchProm = fetch(url, {method: 'GET', signal: signal});
        setTimeout(() => controller.abort(), 3000);

        const response = await fetchProm;
        debugLog('Updated UA fetch response:', LOG_LEVELS.DEBUG, response.status, response.statusText);

        if (!response.ok) {
            const errorText = await response.text();
            debugLog('Updated UA fetch failed:', LOG_LEVELS.ERROR, errorText);
            throw new Error(errorText);
        }

        const text = await response.text();
        const ua = JSON.parse(text);
        if (type == 'both') {
            userAgents.pc = ua.edge.windows;
            userAgents.mb = ua.chrome.ios;
            userAgents.pcSource = 'updated';
            userAgents.mbSource = 'updated';
        } else if (type == 'pc') {
            userAgents.pc = ua.edge.windows;
            userAgents.pcSource = 'updated';
        } else if (type == 'mb') {
            userAgents.mb = ua.chrome.ios;
            userAgents.mbSource = 'updated';
        }
        assertUA();
    } catch (ex) {
        debugLog('Updated UA fetch error:', LOG_LEVELS.ERROR, {
            name: ex.name,
            message: ex.message,
            stack: ex.stack
        });
        
        if (ex.name === 'AbortError') {
            throw new FetchFailedException('getUpdatedUA', ex, 'Fetch timed out. Failed to update user agents. Do you have internet connection? Otherwise, perhaps Github server is down.');
        }
        throw new FetchFailedException('getUpdatedUA', ex);
    }
}

function assertUA() {
    debugLog('Asserting user agents:', LOG_LEVELS.DEBUG, userAgents);
    
    if (!userAgents) {
        const error = new UserAgentInvalidException('User agents object is null');
        debugLog('UA assertion failed - null object:', LOG_LEVELS.ERROR, error);
        throw error;
    }
    
    if (!userAgents.pc || !userAgents.mb) {
        const error = new UserAgentInvalidException('Failed to assert user agents - missing PC or mobile UA. \n UA:\n' + JSON.stringify(userAgents));
        debugLog('UA assertion failed - missing values:', LOG_LEVELS.ERROR, error);
        throw error;
    }
    
    // Validate UA format - ensure they're not empty or too short
    if (typeof userAgents.pc !== 'string' || userAgents.pc.length < 20) {
        const error = new UserAgentInvalidException('Invalid PC user agent format detected: ' + userAgents.pc);
        debugLog('PC UA format validation failed:', LOG_LEVELS.ERROR, error);
        throw error;
    }
    
    if (typeof userAgents.mb !== 'string' || userAgents.mb.length < 20) {
        const error = new UserAgentInvalidException('Invalid Mobile user agent format detected: ' + userAgents.mb);
        debugLog('Mobile UA format validation failed:', LOG_LEVELS.ERROR, error);
        throw error;
    }
    
    console.log('User agents validated successfully:', {
        pcUA: userAgents.pc.substring(0, 40) + '...',
        mbUA: userAgents.mb.substring(0, 40) + '...',
        pcSource: userAgents.pcSource,
        mbSource: userAgents.mbSource
    });
}

function formatTimeRemaining(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

if (typeof module !== 'undefined') {
    module.exports = {
        debugLog,
        LOG_LEVELS,
        setLogLevel,
        formatTimeRemaining,
        checkNewDay
    };
}
