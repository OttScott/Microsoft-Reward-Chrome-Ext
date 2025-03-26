'use strict';

// Initialize variables
let developer = false;
let userAgents;
let _compatibilityMode;
let _pcUaOverrideEnable;
let _mbUaOverrideEnable;
let _pcUaOverrideValue;
let _mbUaOverrideValue;
let workIntervalId = null;  // Store interval ID for cleanup
let scheduledWorkTimer = null; // Store scheduled wake-up timer
let nextScheduledTime = null; // Store next scheduled time
let connectivityResolveTimer = null; // Timer for connectivity resolution

// Initialize core objects
let googleTrend = new GoogleTrend();
let userDailyStatus = new DailyRewardStatus();
let searchQuest = new SearchQuest(googleTrend);

console.log('Background script loading - ' + new Date().toISOString());

// Add a variable to track when the extension was started
let extensionStartTime = Date.now();
// Minimum time (in ms) before we consider allowing the badge to turn green
const MIN_RUNTIME_BEFORE_DONE = 60000; // 1 minute

function onExtensionLoad() {
    console.log('Microsoft Rewards Bot: Extension starting...');
    try {
        setBadge(new GreyBadge());
        console.log('Badge set to grey');
        loadSavedSettings();
        getDeveloperSettings();
        
        // Add emergency check
        checkAndFixCoreComponents();
        
        console.log('Microsoft Rewards Bot: Scheduling initialization...');
        setDelayedInitialisation(5000);
    } catch (error) {
        console.error('Error in onExtensionLoad:', error);
    }
}

function loadSavedSettings() {
    console.log('Loading saved settings...');
    chrome.storage.sync.get({
        compatibilityMode: false,
        pcUaOverrideEnable: false,
        mbUaOverrideEnable: false,
        pcUaOverrideValue: '',
        mbUaOverrideValue: '',
        startTime: '09:00',      // Add default schedule settings
        endTime: '17:00',
        enableSchedule: false,
        baseSearchCount: 30,
        searchVariation: 5
    }, function (options) {
        _compatibilityMode = options.compatibilityMode;
        _pcUaOverrideEnable = options.pcUaOverrideEnable;
        _mbUaOverrideEnable = options.mbUaOverrideEnable;
        _pcUaOverrideValue = options.pcUaOverrideValue;
        _mbUaOverrideValue = options.mbUaOverrideValue;
        // Schedule settings will be read directly from storage
    });
}

async function getDeveloperSettings() {
    const devJson = chrome.runtime.getURL('developer.json');
    const fetchProm = await fetch(devJson, {method: 'GET'}).then((response) => {
        return response.json();
    }).then((json) => {
        developer = json;
        console.log('Developer mode enabled.');
        console.log(developer);
    }).catch((ex) => {
        if (ex.name == 'TypeError') {
            return;
        }
        throw ex;
    });
}

// -----------------------------
// Work
// ----------------------------- 
function setDelayedInitialisation(ms) {
    setTimeout(
        function () {
            initialize();
        },
        ms,
    );
}

// Add reconnection tracking
let reconnectionAttempts = 0;
let lastConnectionFailTime = null;
const MAX_RECONNECTION_BACKOFF_MINUTES = 30; // Max backoff time in minutes
const INITIAL_RECONNECTION_DELAY = 60000; // 1 minute initial retry delay

async function initialize() {
    console.log('Microsoft Rewards Bot: Initialization started');
    
    // Set log level to INFO by default
    setLogLevel(LOG_LEVELS.INFO);
    
    // Check core components again
    await checkAndFixCoreComponents();
    
    // Check if it's a new day since last run
    checkNewDay();
    
    // Reset DailyRewardStatus to ensure it's properly initialized
    if (userDailyStatus) {
        userDailyStatus.reset();
    } else {
        userDailyStatus = new DailyRewardStatus();
    }
    
    // Ensure proper loading of user agent settings
    try {
        await getUA();
    } catch (error) {
        console.error('Failed to load user agents:', error);
    }
    
    // Initial work attempt
    await doBackgroundWork();

    // Clear any existing interval
    if (workIntervalId) {
        clearInterval(workIntervalId);
        workIntervalId = null;
    }

    // Instead of fixed interval, schedule based on settings
    scheduleNextWork();
    
    // Setup midnight reset timer
    setupMidnightReset();
}

// New function to schedule next work based on search settings
async function scheduleNextWork() {
    // Clear any existing scheduled work
    if (scheduledWorkTimer) {
        clearTimeout(scheduledWorkTimer);
        scheduledWorkTimer = null;
    }
    
    // Get schedule settings
    const settings = await chrome.storage.sync.get({
        startTime: '09:00',
        endTime: '17:00',
        enableSchedule: false,
        baseSearchInterval: 15,
        intervalVariation: 300
    });
    
    const now = new Date();
    let nextWorkTime;
    
    if (settings.enableSchedule) {
        // Check if we're currently outside the schedule
        const [startHour, startMinute] = settings.startTime.split(':').map(Number);
        const [endHour, endMinute] = settings.endTime.split(':').map(Number);
        
        const startDate = new Date(now);
        startDate.setHours(startHour, startMinute, 0, 0);
        
        const endDate = new Date(now);
        endDate.setHours(endHour, endMinute, 0, 0);
        
        // If current time is before start time today, schedule for start time
        if (now < startDate) {
            nextWorkTime = startDate;
            debugLog(`Outside schedule: Currently ${now.toLocaleTimeString()}, scheduling for start time ${startDate.toLocaleTimeString()}`, LOG_LEVELS.INFO);
        }
        // If current time is after end time today, schedule for start time tomorrow
        else if (now > endDate) {
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(startHour, startMinute, 0, 0);
            nextWorkTime = tomorrow;
            debugLog(`Outside schedule: Currently ${now.toLocaleTimeString()}, scheduling for tomorrow ${tomorrow.toLocaleTimeString()}`, LOG_LEVELS.INFO);
        }
    }
    
    // If we're within schedule or schedule is disabled, use interval settings
    if (!nextWorkTime) {
        // Calculate next run with randomization
        const baseMs = settings.baseSearchInterval * 60 * 1000; // Base interval in ms
        const randomFactor = Math.random() - 0.5; // -0.5 to 0.5
        const variationMs = randomFactor * settings.intervalVariation * 2 * 1000; // Convert seconds to ms
        const intervalMs = Math.max(60000, baseMs + variationMs); // Minimum 1 minute
        
        nextWorkTime = new Date(now.getTime() + intervalMs);
        debugLog(`Scheduling next work in ${Math.round(intervalMs/60000)} minutes (${nextWorkTime.toLocaleTimeString()})`, LOG_LEVELS.INFO);
    }
    
    // Store the next scheduled time
    nextScheduledTime = nextWorkTime;
    
    // Schedule the next work
    const timeUntilNextMs = Math.max(10000, nextWorkTime - now); // Minimum 10 seconds
    scheduledWorkTimer = setTimeout(() => {
        debugLog(`Executing scheduled work at ${new Date().toLocaleTimeString()}`, LOG_LEVELS.INFO);
        doBackgroundWork().then(() => {
            // Schedule the next work after completion
            scheduleNextWork();
        });
    }, timeUntilNextMs);
}

function setupMidnightReset() {
    // Calculate time until next midnight
    const now = new Date();
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0); // Next midnight
    
    const timeUntilMidnight = midnight - now;
    
    debugLog(`Scheduling midnight reset in ${Math.round(timeUntilMidnight/1000/60)} minutes`, LOG_LEVELS.INFO);
    
    // Schedule the reset
    setTimeout(() => {
        debugLog('Executing midnight reset', LOG_LEVELS.INFO);
        
        // Reset all counters and status for the new day
        checkNewDay();
        resetDailyCounters();
        
        // Reset retry counters
        reconnectionAttempts = 0;
        lastConnectionFailTime = null;
        
        // Force searchQuest and userDailyStatus to reset and recalculate everything
        if (searchQuest) searchQuest.reset();
        if (userDailyStatus) userDailyStatus.reset();
        if (googleTrend) googleTrend.reset();
        
        // If there are ongoing searches, forcibly pause them
        if (searchQuest && searchQuest.jobStatus === STATUS_BUSY) {
            debugLog('Forcibly pausing ongoing searches at midnight', LOG_LEVELS.INFO);
            pauseActiveSearches();
        }
        
        // Check if we're now within scheduled hours
        isWithinSchedule().then(withinSchedule => {
            if (withinSchedule) {
                // Start work shortly after midnight if we're within schedule
                setTimeout(() => {
                    debugLog('Starting post-midnight background work', LOG_LEVELS.INFO);
                    doBackgroundWork();
                }, 60000); // Start work 1 minute after midnight
            } else {
                debugLog('Outside scheduled hours after midnight reset - waiting until scheduled start time', LOG_LEVELS.INFO);
            }
        });
        
        // Reschedule for next midnight
        setupMidnightReset();
    }, timeUntilMidnight);
}

async function isWithinSchedule() {
    const settings = await chrome.storage.sync.get({
        startTime: '09:00',
        endTime: '17:00',
        enableSchedule: false
    });

    if (!settings.enableSchedule) {
        // If schedule is disabled, we're always "within schedule"
        return true;
    }

    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();
    
    const [startHour, startMinute] = settings.startTime.split(':').map(Number);
    const [endHour, endMinute] = settings.endTime.split(':').map(Number);
    
    const startMinutes = startHour * 60 + startMinute;
    const endMinutes = endHour * 60 + endMinute;

    const isWithin = currentTime >= startMinutes && currentTime <= endMinutes;
    
    if (!isWithin) {
        debugLog(`Outside scheduled hours (${settings.startTime}-${settings.endTime}), current time: ${Math.floor(currentTime/60)}:${(currentTime%60).toString().padStart(2, '0')}`, LOG_LEVELS.INFO);
        
        // If we have ongoing searches, forcibly pause them
        if (searchQuest.jobStatus === STATUS_BUSY) {
            debugLog('Forcibly pausing ongoing searches due to schedule end time', LOG_LEVELS.INFO);
            await pauseActiveSearches();
        }
        
        // Schedule wake-up at next start time
        scheduleWakeUp(startHour, startMinute);
    } else if (searchQuest._pausedBySchedule) {
        // If we're now within schedule and searches were paused by schedule, resume them
        debugLog('Within schedule hours and searches were previously paused - resuming', LOG_LEVELS.INFO);
        searchQuest._pausedBySchedule = false;
        
        // Force a new background work cycle
        setTimeout(doBackgroundWork, 5000);
    }

    return isWithin;
}

// New function to handle pausing active searches
async function pauseActiveSearches() {
    try {
        // Store current search status for resumption if needed
        chrome.storage.local.set({
            'searchPausedAt': new Date().toISOString(),
            'searchPausedReason': 'scheduleEnd'
        });
        
        // Send notification that searches were paused
        chrome.notifications.create('searches-paused', {
            type: 'basic',
            iconUrl: 'img/off@8x.png',
            title: 'Searches Paused',
            message: 'Searches paused due to schedule end time. Will resume at next scheduled start time.',
            priority: 1
        });
        
        // If searchQuest is active, try to gracefully stop it
        if (searchQuest && searchQuest.jobStatus === STATUS_BUSY) {
            debugLog('Attempting to pause active search quest', LOG_LEVELS.INFO);
            
            // Add a flag to indicate searches were paused due to schedule
            searchQuest._pausedBySchedule = true;
            
            // Force the search quest to stop after current search
            if (typeof searchQuest.forceStop === 'function') {
                await searchQuest.forceStop();
            } else {
                // If forceStop doesn't exist, implement the backup method
                searchQuest._jobStatus_ = STATUS_DONE;
                searchQuest._currentSearchType_ = null;
            }
            
            debugLog('Search quest paused successfully', LOG_LEVELS.INFO);
        }
        
        // Set the inactive badge
        setBadge(new ScheduleInactiveBadge());
        
        return true;
    } catch (error) {
        console.error('Error pausing active searches:', error);
        return false;
    }
}

// Function to schedule wake-up at start time
function scheduleWakeUp(startHour, startMinute) {
    const now = new Date();
    const wakeupDate = new Date();
    
    // If start time is earlier than current time, schedule for tomorrow
    if (wakeupDate.getHours() > startHour || 
        (wakeupDate.getHours() === startHour && wakeupDate.getMinutes() >= startMinute)) {
        wakeupDate.setDate(wakeupDate.getDate() + 1);
    }
    
    wakeupDate.setHours(startHour, startMinute, 0, 0);
    
    const timeUntilWakeupMs = wakeupDate - now;
    debugLog(`Scheduling wake-up at ${wakeupDate.toLocaleTimeString()} (in ${Math.round(timeUntilWakeupMs/60000)} minutes)`, LOG_LEVELS.INFO);
    
    // Clear any existing scheduled work
    if (scheduledWorkTimer) {
        clearTimeout(scheduledWorkTimer);
    }
    
    // Set the next scheduled time
    nextScheduledTime = wakeupDate;
    
    // Schedule wake-up
    scheduledWorkTimer = setTimeout(() => {
        debugLog(`Executing scheduled wake-up at ${new Date().toLocaleTimeString()}`, LOG_LEVELS.INFO);
        doBackgroundWork();
    }, timeUntilWakeupMs);
}

async function waitTillOnline() {
    if (navigator.onLine) {
        // Quick check if we have internet according to the browser
        const hasInternet = await checkInternetConnectivity();
        if (hasInternet) {
            reconnectionAttempts = 0; // Reset reconnection counter on success
            lastConnectionFailTime = null;
            
            // If we had a connectivity timer set, clear it as we're now online
            if (connectivityResolveTimer) {
                clearTimeout(connectivityResolveTimer);
                connectivityResolveTimer = null;
            }
            
            return;
        }
    }
    
    // We're offline or connectivity check failed
    if (!lastConnectionFailTime) {
        lastConnectionFailTime = Date.now();
    }
    
    reconnectionAttempts++;
    const backoffMinutes = Math.min(
        Math.pow(2, Math.min(reconnectionAttempts - 1, 5)), // Exponential backoff up to 32x
        MAX_RECONNECTION_BACKOFF_MINUTES
    );
    
    const waitTime = INITIAL_RECONNECTION_DELAY * backoffMinutes;
    
    debugLog(`Internet connection unavailable. Attempt ${reconnectionAttempts}. Waiting ${waitTime/1000} seconds before retry.`, LOG_LEVELS.WARN);
    setBadge(new WarningBadge());
    
    // Set a timer for connectivity resolution
    if (connectivityResolveTimer) {
        clearTimeout(connectivityResolveTimer);
    }
    
    // Use schedule timer for next connectivity check if it will be sooner
    if (nextScheduledTime && (Date.now() + waitTime) > nextScheduledTime) {
        debugLog(`Next scheduled run at ${nextScheduledTime.toLocaleTimeString()} will check connectivity`, LOG_LEVELS.INFO);
        return;
    }
    
    connectivityResolveTimer = setTimeout(async () => {
        const hasInternet = await checkInternetConnectivity();
        if (hasInternet) {
            debugLog('Internet connection restored', LOG_LEVELS.INFO);
            reconnectionAttempts = 0;
            lastConnectionFailTime = null;
            setBadge(new GreyBadge());
            
            // Restart background work after connectivity is restored
            doBackgroundWork();
        } else {
            // Still offline, try again with waitTillOnline
            waitTillOnline();
        }
    }, waitTime);
}

async function doBackgroundWork() {
    console.log('Background work starting...');
    
    // Add guard against rapid retries
    const lastWorkTime = await chrome.storage.local.get('lastWorkAttempt');
    const now = Date.now();
    
    if (lastWorkTime.lastWorkAttempt) {
        const timeSinceLastWork = now - lastWorkTime.lastWorkAttempt;
        const MINIMUM_WORK_INTERVAL = 30000; // 30 seconds minimum between attempts
        
        if (timeSinceLastWork < MINIMUM_WORK_INTERVAL) {
            console.log(`Too soon to retry work (${Math.round(timeSinceLastWork/1000)}s < ${MINIMUM_WORK_INTERVAL/1000}s), skipping...`);
            return;
        }
    }
    
    // Store this attempt time
    await chrome.storage.local.set({ lastWorkAttempt: now });
    
    // Check day change first
    await checkDayChange();
    
    // Update daily reset 
    checkNewDay();
    
    if (!await isWithinSchedule()) {
        console.log('Outside scheduled hours, pausing work');
        return;
    }
    
    // Check for connectivity before proceeding
    await waitTillOnline();
    
    // Add guard against parallel execution
    if (searchQuest.jobStatus === STATUS_BUSY || userDailyStatus.jobStatus === STATUS_BUSY) {
        console.log('Work already in progress, skipping...');
        return;
    }

    // Set badge to busy while we work
    setBadge(new BusyBadge());
    
    try {
        // Store the search status before we check
        const initialPcCompleted = userDailyStatus?.pcSearchStatus?.isCompleted || false;
        const initialMbCompleted = userDailyStatus?.mbSearchStatus?.isCompleted || false;
        
        console.log('Initial search completion status:', {
            pcCompleted: initialPcCompleted,
            mbCompleted: initialMbCompleted
        });
        
        // Run the reward status check
        await checkDailyRewardStatus();
        
        // Log the current search quest job status
        console.log('Search quest job status after reward check:', {
            status: searchQuest.jobStatus,
            statusName: searchQuest.jobStatus === STATUS_DONE ? 'DONE' : 
                        searchQuest.jobStatus === STATUS_BUSY ? 'BUSY' : 
                        searchQuest.jobStatus === STATUS_ERROR ? 'ERROR' : 'NONE',
            pcCompleted: userDailyStatus?.pcSearchStatus?.isCompleted || false,
            mbCompleted: userDailyStatus?.mbSearchStatus?.isCompleted || false
        });
        
        // Check how long the extension has been running
        const runtimeMs = Date.now() - extensionStartTime;
        console.log(`Extension runtime: ${Math.round(runtimeMs/1000)} seconds`);
        
        // Only set the badge to done if:
        // 1. We were in busy state
        // 2. Searches were really completed (either already completed or completed in this run)
        // 3. Extension has been running for at least MIN_RUNTIME_BEFORE_DONE
        if (isCurrentBadge('busy')) {
            // Check if searches are completed
            const areSearchesCompleted = 
                (userDailyStatus?.pcSearchStatus?.isCompleted || !userDailyStatus?.pcSearchStatus?.isValid) && 
                (userDailyStatus?.mbSearchStatus?.isCompleted || !userDailyStatus?.mbSearchStatus?.isValid);
            
            // Check if we performed any searches in this run
            const didSearchesThisRun = 
                (!initialPcCompleted && userDailyStatus?.pcSearchStatus?.isCompleted) ||
                (!initialMbCompleted && userDailyStatus?.mbSearchStatus?.isCompleted);
                
            // Only allow the badge to turn green if the extension has been running for a minimum time
            const canShowDone = runtimeMs >= MIN_RUNTIME_BEFORE_DONE;
                
            console.log('Search completion status for badge decision:', {
                areSearchesCompleted: areSearchesCompleted,
                didSearchesThisRun: didSearchesThisRun,
                searchQuestStatus: searchQuest.jobStatus,
                runtimeMs: runtimeMs,
                canShowDone: canShowDone
            });
            
            if (areSearchesCompleted && canShowDone) {
                console.log('All searches are completed and minimum runtime reached, setting badge to done');
                setBadge(new DoneBadge());
            } else if (areSearchesCompleted && !canShowDone) {
                console.log('Searches completed but not showing done badge yet (runtime < minimum)');
                // Schedule a timeout to set the done badge after minimum runtime
                const remainingTime = MIN_RUNTIME_BEFORE_DONE - runtimeMs;
                console.log(`Will set done badge after ${Math.round(remainingTime/1000)} more seconds`);
                
                // Keep busy badge for now
                setTimeout(() => {
                    // Double check that conditions are still true
                    if (areSearchesCompleted && !searchQuest.jobStatus === STATUS_BUSY) {
                        console.log('Setting delayed done badge after minimum runtime');
                        setBadge(new DoneBadge());
                    }
                }, remainingTime);
            } else if (didSearchesThisRun) {
                console.log('Searches performed in this run but more needed, keeping busy badge');
                // Keep busy badge to indicate work in progress
            } else {
                console.log('No searches were performed, returning to grey badge');
                setBadge(new GreyBadge());
            }
        }
    } catch (error) {
        console.error('Error in daily reward status check:', error);
        // Don't immediately retry on error
        setBadge(new ErrorBadge());
        return;
    }
    
    // After work completion, schedule the next run with proper timing
    scheduleNextWork();
}

// Add a new function to explicitly check for day changes
async function checkDayChange() {
    try {
        const data = await chrome.storage.local.get({
            lastRunDate: '',
            lastSearchTime: null
        });
        
        const today = new Date().toLocaleDateString();
        const lastRunDate = data.lastRunDate;
        
        // If we have a last search time, check if it's from a previous day
        if (data.lastSearchTime) {
            const lastSearchDate = new Date(data.lastSearchTime).toLocaleDateString();
            
            if (lastSearchDate !== today) {
                debugLog(`Day change detected: Last search: ${lastSearchDate}, Today: ${today}`, LOG_LEVELS.INFO);
                
                // Reset counters for the new day
                resetDailyCounters();
                
                // Reset objects
                googleTrend.reset();
                searchQuest.reset();
                userDailyStatus.reset();
                
                // Update last run date
                chrome.storage.local.set({lastRunDate: today});
            }
        }
        
        // Always ensure lastRunDate is set
        if (lastRunDate !== today) {
            chrome.storage.local.set({lastRunDate: today});
        }
    } catch (error) {
        console.error('Error checking day change:', error);
    }
}

async function setTimeoutAsync(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkDailyRewardStatus() {
    console.log('Checking daily reward status...');
    
    // Add status check cooldown
    const lastStatusCheck = await chrome.storage.local.get('lastStatusCheck');
    const now = Date.now();
    const STATUS_CHECK_COOLDOWN = 10000; // 10 seconds between status checks
    
    if (lastStatusCheck.lastStatusCheck) {
        const timeSinceLastCheck = now - lastStatusCheck.lastStatusCheck;
        if (timeSinceLastCheck < STATUS_CHECK_COOLDOWN) {
            console.log(`Status check too frequent (${Math.round(timeSinceLastCheck/1000)}s < ${STATUS_CHECK_COOLDOWN/1000}s), skipping...`);
            return;
        }
    }
    
    // Store this check time
    await chrome.storage.local.set({ lastStatusCheck: now });
    
    // Ensure status object is initialized
    if (!userDailyStatus) {
        console.error('Daily status object is null, recreating');
        userDailyStatus = new DailyRewardStatus();
    }
    
    console.log('Updating user daily status...');
    
    try {
        const result = await userDailyStatus.update();
        console.log('Status update complete, result:', result);
        
        if (!result || !userDailyStatus.summary || !userDailyStatus.summary.isValid) {
            throw new Error('Invalid status update result');
        }
        
        await doSearchQuests();
        await checkQuizAndDaily();
        
    } catch (error) {
        console.error('Error in daily status update:', error);
        throw error; // Propagate error up
    }
}

// Add the missing function
async function checkQuizAndDaily() {
    console.log('Checking quiz and daily activities...');
    
    try {
        // For now, this is just a placeholder to prevent errors
        // In the future, this could be expanded to handle quiz activities
        if (!userDailyStatus || !userDailyStatus.summary) {
            console.warn('Cannot check quiz/daily activities: user status not available');
            return;
        }
        
        if (userDailyStatus.quizAndDailyStatus && userDailyStatus.quizAndDailyStatus.pointsToGet > 0) {
            console.log(`Quiz/daily activities have ${userDailyStatus.quizAndDailyStatus.pointsToGet} points available`);
            // Future: Implement logic to complete quizzes and daily activities
        } else {
            console.log('No quiz/daily activities to complete or already completed');
        }
        
        debugLog('Quiz and daily activities check completed', LOG_LEVELS.INFO);
    } catch (error) {
        console.error('Error checking quiz and daily activities:', error);
        // Don't let this error interrupt the overall flow
    }
}

async function doSearchQuests() {
    try {
        console.log('Starting search quests check...');
        
        if (!userDailyStatus || !userDailyStatus.summary) {
            console.error('Invalid user status for search quests, aborting');
            return;
        }
        
        // Log detailed status for debugging
        console.log('Search completion status from userDailyStatus:', {
            summaryIsCompleted: userDailyStatus.summary.isCompleted,
            pcSearchStatus: {
                isCompleted: userDailyStatus.pcSearchStatus.isCompleted,
                progress: userDailyStatus.pcSearchStatus.progress,
                progressMax: userDailyStatus.pcSearchStatus.progressMax,
                searchNeededCount: userDailyStatus.pcSearchStatus.searchNeededCount
            },
            mbSearchStatus: {
                isCompleted: userDailyStatus.mbSearchStatus.isCompleted,
                progress: userDailyStatus.mbSearchStatus.progress,
                progressMax: userDailyStatus.mbSearchStatus.progressMax,
                searchNeededCount: userDailyStatus.mbSearchStatus.searchNeededCount
            }
        });
        
        // IMPORTANT FIX: Force search flag to true - this overrides the auto-detection
        // which is incorrectly determining searches are completed
        const forceSearches = true;
        
        // Fix the logic to determine if searches are needed
        // 1. If PC searches are not completed and valid, we need searches
        // 2. If mobile searches are not completed and valid, we need searches 
        // 3. If forceSearches is true, we always do searches
        const areSearchesNeeded = forceSearches || 
            (!userDailyStatus.pcSearchStatus.isCompleted && userDailyStatus.pcSearchStatus.isValid) || 
            (!userDailyStatus.mbSearchStatus.isCompleted && userDailyStatus.mbSearchStatus.isValid);
        
        console.log('Are searches needed:', areSearchesNeeded, '(forced:', forceSearches, ')');
        
        if (!areSearchesNeeded) {
            console.log('No searches needed based on detailed status check.');
            return;
        }
        
        // Reset stored search counts to ensure we start fresh
        await chrome.storage.local.set({
            pcSearchCount: 0,
            mbSearchCount: 0,
        });
        console.log('Reset search counts to ensure searches will run');
        
        // Always verify user agents before starting searches
        if (!userAgents || !userAgents.pc || !userAgents.mb) {
            console.warn('User agents not properly initialized, attempting to reload...');
            try {
                await getUA();
            } catch (uaError) {
                console.error('Failed to initialize user agents:', uaError);
                // Try fallbacks
                await loadFallbackUserAgents();
            }
        }
        
        console.log('Searches needed. Starting search quest work...', {
            userAgents: {
                pc: userAgents?.pc ? 'set' : 'missing',
                mb: userAgents?.mb ? 'set' : 'missing',
                pcSource: userAgents?.pcSource,
                mbSource: userAgents?.mbSource
            }
        });
        
        try {
            // Reset the search quest to ensure fresh state
            searchQuest.reset();
            
            // Force progress tracking properties to reset
            userDailyStatus.pcSearchStatus.progress = 0;
            userDailyStatus.pcSearchStatus.isCompleted = false;
            userDailyStatus.mbSearchStatus.progress = 0;
            userDailyStatus.mbSearchStatus.isCompleted = false;
            
            // Start the search work
            await searchQuest.doWork(userDailyStatus);
        } catch (searchEx) {
            // If it's specifically a UA error, handle it gracefully
            if (searchEx instanceof UserAgentInvalidException) {
                console.error('User agent issue detected:', searchEx.message);
                
                // Clear any cached UA information and reset for fresh start
                chrome.storage.local.remove([
                    'lastUpdatedUA',
                    'stableUA',
                    'updatedUA'
                ]);
                
                // Try to reload with fallback UAs
                try {
                    await loadFallbackUserAgents();
                    
                    // Reset search quest to try again with fallback UAs
                    searchQuest.reset();
                    
                    // Optionally notify user about the issue
                    chrome.notifications.create('ua-fallback-notification', {
                        type: 'basic',
                        iconUrl: 'img/warn@8x.png',
                        title: 'Microsoft Rewards Bot',
                        message: 'Using fallback user agents due to issues with regular UA settings',
                        priority: 1
                    });
                    
                    // Immediately retry with fallback UAs
                    console.log('Retrying searches with fallback user agents...');
                    setTimeout(async () => {
                        try {
                            await searchQuest.doWork(userDailyStatus);
                        } catch (retryError) {
                            console.error('Retry with fallback UAs also failed:', retryError);
                            setBadge(new ErrorBadge());
                        }
                    }, 5000);
                } catch (fallbackEx) {
                    console.error('Failed to load fallback UAs:', fallbackEx);
                    setBadge(new ErrorBadge());
                }
            } else {
                // For other errors, re-throw
                throw searchEx;
            }
        }
    } catch (ex) {
        console.error('Error in search quests:', ex);
        handleException(ex);
    }
}

async function _requestBingSearch() {
    // ...existing code...

    try {
        // Before starting search, check if we'll exceed schedule
        const settings = await chrome.storage.sync.get({
            endTime: '17:00',
            enableSchedule: false
        });
        
        if (settings.enableSchedule) {
            const [endHour, endMinute] = settings.endTime.split(':').map(Number);
            const endMinutes = endHour * 60 + endMinute;
            
            const now = new Date();
            const searchEndTime = new Date(now.getTime() + this._searchIntervalMS);
            const searchEndMinutes = searchEndTime.getHours() * 60 + searchEndMinutes.getMinutes();
            
            if (searchEndMinutes > endMinutes) {
                console.log('Next search would exceed schedule, delaying until next start time');
                setBadge(new ScheduleInactiveBadge());
                return;
            }
        }

        // Continue with search...
        // ...existing code...
    } catch (ex) {
        // ...existing code...
    }
}

const WORKER_ACTIVATION_INTERVAL = 7200000; // Interval at which automatic background works are carried out, in ms.
const WAIT_FOR_ONLINE_TIMEOUT = 60000;

// Basic runtime setup
chrome.runtime.onInstalled.addListener((details) => {
    console.log('Extension installed or updated:', details.reason);
    onExtensionLoad();
});

// Add direct initialization for service workers
if ('serviceWorker' in navigator) {
    console.log('Service worker detected - initializing directly');
    onExtensionLoad();
}

// Add manual trigger for background work
chrome.runtime.onStartup.addListener(() => {
    console.log('Chrome startup detected - initializing');
    onExtensionLoad();
});

// Add a way to force work to start immediately for debugging
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Message received:', message);
    
    try {
        switch (message.action) {
            case 'startSearches':
                console.log('Manually starting searches');
                doBackgroundWork().then(() => {
                    sendResponse({success: true, message: 'Search work started'});
                }).catch(error => {
                    sendResponse({success: false, error: error.message});
                });
                return true; // Keep message channel open for async response
                
            case 'getSearchProgress':
                if (searchQuest && searchQuest.jobStatus === STATUS_BUSY) {
                    const searchInfo = searchQuest.getSearchProgress();
                    console.log('Returning search progress to UI:', searchInfo);
                    
                    // Ensure we send all required properties
                    sendResponse({
                        success: true,
                        inProgress: true,
                        type: searchInfo.type || 'PC',
                        current: searchInfo.current || 0,
                        total: searchInfo.total || 0,
                        timeRemaining: searchInfo.timeRemaining || 0,
                        percentComplete: searchInfo.percentComplete || 0,
                        searchTerm: searchInfo.searchTerm || '[searching...]',
                        nextSearchTerm: searchInfo.nextSearchTerm || '[next term]',
                        nextSearchTime: searchInfo.nextSearchTime || null
                    });
                } else {
                    // Even when not in progress, get terms for display from googleTrend
                    let nextTerm = '';
                    try {
                        if (googleTrend) {
                            nextTerm = googleTrend.getNextTermForDisplay();
                        }
                    } catch (err) {
                        console.warn('Error getting next term:', err);
                        nextTerm = '[next term]';
                    }
                    
                    console.log('Search not in progress. Next term:', nextTerm);
                    
                    sendResponse({
                        success: true,
                        inProgress: false,
                        nextSearchTerm: nextTerm
                    });
                }
                break;
                
            case 'getNextScheduledTime':
                sendResponse({
                    success: true,
                    nextScheduledTime: nextScheduledTime ? nextScheduledTime.toISOString() : null
                });
                break;
                
            case 'getRewardsData':
                // Try to get rewards data from the status object
                try {
                    if (userDailyStatus && userDailyStatus.summary) {
                        const data = {
                            success: true,
                            data: {
                                earnedToday: userDailyStatus.summary.earnedToday || 0,
                                remainingPoints: userDailyStatus.summary.availablePoints || 0,
                                pcSearchProgress: userDailyStatus.pcSearchStatus.progress || 0,
                                pcSearchTotal: userDailyStatus.pcSearchStatus.progressMax || 0,
                                mbSearchProgress: userDailyStatus.mbSearchStatus.progress || 0,
                                mbSearchTotal: userDailyStatus.mbSearchStatus.progressMax || 0
                            },
                            timestamp: new Date().toISOString()
                        };
                        sendResponse(data);
                    } else {
                        // Status not initialized yet
                        sendResponse({
                            success: false,
                            error: 'Status not initialized'
                        });
                    }
                } catch (error) {
                    console.error('Error getting rewards data:', error);
                    sendResponse({
                        success: false,
                        error: error.message || 'Error getting rewards data'
                    });
                }
                break;
                
            case 'searchSkipped':
                // Handle the searchSkipped action
                console.log('Search was manually skipped by user');
                // Send immediate response
                sendResponse({success: true});
                break;
                
            case 'checkConnectivity':
                // Add a direct connectivity check
                checkInternetConnectivity().then(isConnected => {
                    sendResponse({
                        success: true,
                        isConnected: isConnected,
                        browserOnline: navigator.onLine
                    });
                }).catch(error => {
                    sendResponse({
                        success: false,
                        error: error.message,
                        browserOnline: navigator.onLine
                    });
                });
                return true; // Keep the message channel open for the async response
                
            default:
                // For unhandled messages, send a response to avoid hanging
                sendResponse({success: false, error: 'Unknown action'});
                break;
        }
    } catch (error) {
        console.error('Error handling message:', error);
        // Always send a response, even for errors
        sendResponse({
            success: false,
            error: error.message || 'Unknown error'
        });
    }
    
    // Return true if we need to send an async response
    return true;
});

// Service worker events
self.addEventListener('install', event => {
    console.log('Service worker installing...');
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    console.log('Service worker activating...');
    event.waitUntil(clients.claim());
});

// Listen for online/offline events from the browser
self.addEventListener('online', () => {
    debugLog('Browser went online', LOG_LEVELS.INFO);
    // Try to run background work soon after connection is restored
    setTimeout(doBackgroundWork, 5000);
});

self.addEventListener('offline', () => {
    debugLog('Browser went offline', LOG_LEVELS.WARN);
    setBadge(new WarningBadge());
});

// Handle extension unload
chrome.runtime.onSuspend.addListener(() => {
    console.log('Extension suspending, cleaning up...');
    if (workIntervalId) {
        clearInterval(workIntervalId);
        workIntervalId = null;
    }
});

console.log('Background script initialization complete');

// Emergency fix function to check core components
async function checkAndFixCoreComponents() {
    console.log('Emergency checking core components...');
    
    // Check if DailyRewardStatus is properly initialized
    if (!userDailyStatus) {
        console.warn('userDailyStatus is null, creating new instance');
        userDailyStatus = new DailyRewardStatus();
    }
    
    // Check if GoogleTrend is properly initialized
    if (!googleTrend) {
        console.warn('googleTrend is null, creating new instance');
        googleTrend = new GoogleTrend();
    }
    
    // Check if SearchQuest is properly initialized
    if (!searchQuest) {
        console.warn('searchQuest is null, creating new instance');
        searchQuest = new SearchQuest(googleTrend);
    }
    
    // Add logging for debugging class methods
    console.log('Checking user daily status methods:', {
        update: typeof userDailyStatus.update,
        getMSRewardStatusFromBing: typeof userDailyStatus.getMSRewardStatusFromBing,
        summary: userDailyStatus.summary,
        hasError: userDailyStatus._errMsg_ 
    });
}

// Add this function to handle rewards data for the popup
async function getRewardsDataForPopup() {
    try {
        debugLog('Getting rewards data for popup', LOG_LEVELS.INFO);
        
        // Make sure we have up-to-date status
        if (!userDailyStatus || !userDailyStatus.summary || !userDailyStatus.summary.isValid) {
            debugLog('Daily status not ready, updating...', LOG_LEVELS.INFO);
            await userDailyStatus.update();
        }
        
        // Check if we have valid data after update
        if (!userDailyStatus || !userDailyStatus.summary) {
            throw new Error('Failed to load rewards data - user status not valid');
        }
        
        // Get summary directly from status object
        const summary = userDailyStatus.getStatusSummary();
        
        return {
            earnedToday: summary.earnedToday || 0,
            remainingPoints: summary.availablePoints || 0,
            pcSearchProgress: summary.pcSearchStatus.progress || 0,
            pcSearchTotal: summary.pcSearchStatus.progressMax || 0,
            mbSearchProgress: summary.mbSearchStatus.progress || 0,
            mbSearchTotal: summary.mbSearchStatus.progressMax || 0,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        debugLog('Error getting rewards data:', LOG_LEVELS.ERROR, error);
        throw error;
    }
}

// Add this function to get lifetime points (optional enhancement)
async function getLifetimePointsForPopup() {
    try {
        if (!userDailyStatus) {
            throw new Error('User status not available');
        }
        
        // Use the dedicated method for lifetime points
        const lifetimePoints = await userDailyStatus.getLifetimePoints();
        return lifetimePoints;
    } catch (error) {
        debugLog('Error getting lifetime points:', LOG_LEVELS.ERROR, error);
        throw error;
    }
}

// Add this function to check specifically for UA issues
function checkForUAIssues() {
    let hasIssues = false;
    
    if (!userAgents || !userAgents.pc || !userAgents.mb) {
        console.error('User agents not properly initialized');
        hasIssues = true;
    }
    
    // Validate format of user agents
    if (userAgents) {
        if (typeof userAgents.pc !== 'string' || userAgents.pc.length < 20) {
            console.error('Invalid PC user agent:', userAgents.pc);
            hasIssues = true;
        }
        
        if (typeof userAgents.mb !== 'string' || userAgents.mb.length < 20) {
            console.error('Invalid Mobile user agent:', userAgents.mb);
            hasIssues = true;
        }
    }
    
    return hasIssues;
}
