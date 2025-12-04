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
let scheduledWorkTimer = null; // For regular work intervals
let scheduleWakeUpTimer = null; // For scheduled start time wake-ups
let nextScheduledTime = null; // Store next scheduled time
let connectivityResolveTimer = null; // Timer for connectivity resolution
let isSchedulePaused = false; // Track if we're currently paused by schedule

// Initialize core objects
let googleTrend = new GoogleTrend();
let userDailyStatus = new DailyRewardStatus();
let searchQuest = new SearchQuest(googleTrend);

console.log('Background script loading - ' + new Date().toISOString());

// Add a variable to track when the extension was started
let extensionStartTime = Date.now();
// Minimum time (in ms) before we consider allowing the badge to turn green
const MIN_RUNTIME_BEFORE_DONE = 60000; // 1 minute

// Chrome alarm listener for persistent morning startup (survives service worker restarts)
chrome.alarms.onAlarm.addListener(async (alarm) => {
    console.log(`🔔 Alarm triggered: ${alarm.name} at ${new Date().toLocaleString()}`);
    
    if (alarm.name === 'morningRestart') {
        console.log('🌅 Morning restart alarm triggered!');
        await handleMorningRestart();
    } else if (alarm.name === 'periodicCheck') {
        console.log('⏰ Periodic check alarm - checking for missed morning start...');
        await checkForMissedMorningStart();
    }
});

// Periodic check to catch missed morning starts (runs every hour)
async function checkForMissedMorningStart() {
    try {
        const data = await chrome.storage.local.get(['lastRunDate', 'nextDayRestartTime', 'scheduleState']);
        const today = new Date().toDateString();
        const now = new Date();
        
        console.log('Periodic check:', {
            lastRunDate: data.lastRunDate,
            today: today,
            isNewDay: data.lastRunDate !== today,
            scheduleState: data.scheduleState
        });
        
        // If it's a new day and we haven't run today
        if (data.lastRunDate !== today) {
            console.log('🌅 New day detected during periodic check!');
            
            // Check if searches are already running
            if (searchQuest && searchQuest.jobStatus === STATUS_BUSY) {
                console.log('⚠️ Searches already running, skipping duplicate morning start');
                return;
            }
            
            // Check if we should start now
            const isWithin = await isWithinSchedule();
            
            if (isWithin) {
                console.log('🚀 Within schedule during periodic check - starting searches!');
                await handleMorningRestart();
            } else {
                console.log('⏳ Outside schedule - will check again in next period');
            }
        } else {
            console.log('✓ Already ran today, no action needed');
        }
    } catch (error) {
        console.error('Error in periodic check:', error);
    }
}

// Handle morning restart when alarm fires
async function handleMorningRestart() {
    try {
        console.log('🌅 Executing morning restart...');
        
        // CRITICAL: Do not reset if searches are currently running
        if (searchQuest && searchQuest.jobStatus === STATUS_BUSY) {
            console.log('⚠️ Searches already running, skipping morning restart to avoid race condition');
            return;
        }
        
        // Clean up storage
        await chrome.storage.local.remove(['nextDayRestartTime', 'restartReason']);
        
        // Ensure components are initialized
        await checkAndFixCoreComponents();
        
        // Reset all systems for new day
        if (searchQuest) {
            searchQuest.reset();
        }
        if (userDailyStatus) {
            userDailyStatus.reset();
        } else {
            userDailyStatus = new DailyRewardStatus();
        }
        if (googleTrend) {
            googleTrend.reset();
        }
        
        // Load user agents
        try {
            await getUA();
        } catch (error) {
            console.error('Failed to load user agents:', error);
        }
        
        // Clear pause state
        isSchedulePaused = false;
        await chrome.storage.local.set({
            'scheduleState': 'active',
            'isSchedulePaused': false,
            'lastRunDate': new Date().toDateString()
        });
        
        // Check if we're within schedule
        const isWithin = await isWithinSchedule();
        
        if (isWithin) {
            console.log('🟢 Within schedule, starting morning searches...');
            setBadge(new BusyBadge());
            
            // Initialize schedule system
            await initializeScheduleSystem();
            
            // Start searches after a brief delay
            setTimeout(async () => {
                console.log('🚀 Starting morning searches...');
                await doBackgroundWork('morningRestart');
            }, 3000);
        } else {
            console.log('🔘 Outside schedule, setting up schedule monitoring...');
            setBadge(new GreyBadge());
            await initializeScheduleSystem();
        }
        
    } catch (error) {
        console.error('❌ Error in morning restart:', error);
    }
}

// Set up persistent periodic alarm on installation/update
chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('🔧 Extension installed/updated:', details.reason);
    
    // Set up periodic check alarm (every 60 minutes)
    await chrome.alarms.create('periodicCheck', {
        periodInMinutes: 60,
        delayInMinutes: 1 // Start first check after 1 minute
    });
    
    console.log('✅ Periodic check alarm created (runs every 60 minutes)');
    
    // Immediately check for missed morning start
    await checkForMissedMorningStart();
});

function onExtensionLoad() {
    console.log('Microsoft Rewards Bot: Extension starting...');
    try {
        setBadge(new GreyBadge());
        console.log('Badge set to grey (initial)');
        loadSavedSettings();
        getDeveloperSettings();
        
        // Add emergency check
        checkAndFixCoreComponents();
        
        // Check for persistent schedule state and recover if needed
        recoverFromServiceWorkerRestart();
        
        console.log('Microsoft Rewards Bot: Scheduling initialization...');
        
        // Try immediate initialization for fast startup
        setTimeout(async () => {
            try {
                await initialize();
            } catch (error) {
                console.error('Immediate initialization failed, trying delayed:', error);
                setDelayedInitialisation(5000);
            }
        }, 1000);
        
        // Also set a delayed initialization as backup
        setDelayedInitialisation(8000);
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
        searchVariation: 5,
        smartSwitching: true,    // Default to smart switching enabled
        interleaveSearches: false // Default to traditional sequential searches
    }, function (options) {
        _compatibilityMode = options.compatibilityMode;
        _pcUaOverrideEnable = options.pcUaOverrideEnable;
        _mbUaOverrideEnable = options.mbUaOverrideEnable;
        _pcUaOverrideValue = options.pcUaOverrideValue;
        _mbUaOverrideValue = options.mbUaOverrideValue;
        // Schedule settings will be read directly from storage
        console.log('Loaded search behavior settings:', {
            smartSwitching: options.smartSwitching,
            interleaveSearches: options.interleaveSearches
        });
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
    
    // Initialize the robust scheduling system
    console.log('Initializing scheduling system...');
    await initializeScheduleSystem();
    
    // Check and restore next-day restart timer if needed
    await checkAndRestoreNextDayTimer();

    // Initial work attempt (only if within schedule)
    console.log('Starting initial background work...');
    await doBackgroundWork('initialization');
    
    // Set proper initial badge based on current state (after work attempt)
    await setInitialBadgeState();
    
    // Clear any existing interval
    if (workIntervalId) {
        clearInterval(workIntervalId);
        workIntervalId = null;
    }

    // Instead of fixed interval, schedule based on settings
    console.log('Scheduling next work...');
    scheduleNextWork();
    
    // Setup midnight reset timer
    setupMidnightReset();
    
    console.log('Microsoft Rewards Bot: Initialization completed');
}

// Enhanced function to schedule next work with persistent scheduling
async function scheduleNextWork() {
    console.log('scheduleNextWork() called');
    
    // Clear any existing scheduled work
    if (scheduledWorkTimer) {
        clearTimeout(scheduledWorkTimer);
        scheduledWorkTimer = null;
        console.log('Cleared existing scheduledWorkTimer');
    }
    
    // Don't schedule if we're paused by schedule (but only if scheduling is enabled)
    const scheduleSettings = await chrome.storage.sync.get(['enableSchedule']);
    if (isSchedulePaused && scheduleSettings.enableSchedule) {
        console.log('Currently paused by schedule, not scheduling regular work');
        return;
    }
    
    // Get schedule settings
    const settings = await chrome.storage.sync.get({
        baseSearchInterval: 15,
        intervalVariation: 300,
        enableSchedule: false
    });
    
    console.log('Schedule settings loaded:', settings);
    
    // Calculate next run with randomization
    const baseMs = settings.baseSearchInterval * 60 * 1000; // Base interval in ms
    const randomFactor = Math.random() - 0.5; // -0.5 to 0.5
    const variationMs = randomFactor * settings.intervalVariation * 2 * 1000; // Convert seconds to ms
    const intervalMs = Math.max(60000, baseMs + variationMs); // Minimum 1 minute
    
    const now = new Date();
    const nextWorkTime = new Date(now.getTime() + intervalMs);
    
    console.log(`Scheduling next regular work in ${Math.round(intervalMs/60000)} minutes (${nextWorkTime.toLocaleTimeString()})`);
    
    // Store the next scheduled time for persistence
    try {
        await chrome.storage.local.set({
            'nextRegularWorkTime': nextWorkTime.toISOString(),
            'regularWorkInterval': intervalMs
        });
        console.log('Stored next work time to storage:', nextWorkTime.toISOString());
    } catch (error) {
        console.error('Error storing next work time:', error);
    }
    
    // Schedule the next work
    scheduledWorkTimer = setTimeout(async () => {
        console.log(`Executing scheduled regular work at ${new Date().toLocaleTimeString()}`);
        
        try {
            await doBackgroundWork();
        } catch (error) {
            console.error('Error in scheduled background work:', error);
        }
        
        // Schedule the next work after completion (if not paused)
        if (!isSchedulePaused) {
            scheduleNextWork();
        }
    }, intervalMs);
    
    console.log('scheduledWorkTimer set with ID:', scheduledWorkTimer);
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

// Schedule automatic restart for the next day when all searches are completed
// Uses Chrome Alarms API for persistence across service worker restarts
async function scheduleNextDayRestart() {
    console.log('🔔 Scheduling next day restart with Chrome alarms...');
    
    try {
        // Get schedule settings to determine when to restart tomorrow
        const settings = await chrome.storage.sync.get({
            'enableSchedule': false,
            'startTime': '09:00',
            'endTime': '17:00'
        });
        
        const now = new Date();
        let nextRestartTime;
        
        if (settings.enableSchedule) {
            // If scheduling is enabled, restart at the scheduled start time tomorrow
            const [startHour, startMinute] = settings.startTime.split(':').map(Number);
            nextRestartTime = new Date();
            nextRestartTime.setDate(now.getDate() + 1); // Tomorrow
            nextRestartTime.setHours(startHour, startMinute, 0, 0);
        } else {
            // If no schedule, restart at 6 AM tomorrow as a reasonable default
            nextRestartTime = new Date();
            nextRestartTime.setDate(now.getDate() + 1); // Tomorrow
            nextRestartTime.setHours(6, 0, 0, 0); // 6 AM
        }
        
        const timeUntilRestart = nextRestartTime - now;
        
        console.log(`🔔 Next day restart scheduled for: ${nextRestartTime.toLocaleString()} (in ${Math.round(timeUntilRestart/1000/60/60)} hours)`);
        
        // Store the restart time for persistence and debugging
        await chrome.storage.local.set({
            'nextDayRestartTime': nextRestartTime.toISOString(),
            'restartReason': 'morningAutoStart',
            'lastScheduledDate': new Date().toDateString()
        });
        
        // Clear any existing alarm
        await chrome.alarms.clear('morningRestart');
        
        // Create Chrome alarm (survives service worker restarts)
        await chrome.alarms.create('morningRestart', {
            when: nextRestartTime.getTime()
        });
        
        console.log('✅ Morning restart alarm created successfully');
        
        // Also ensure periodic check alarm exists
        const alarms = await chrome.alarms.getAll();
        if (!alarms.find(a => a.name === 'periodicCheck')) {
            await chrome.alarms.create('periodicCheck', {
                periodInMinutes: 60,
                delayInMinutes: 1
            });
            console.log('✅ Periodic check alarm also created');
        }
        
        // Also keep setTimeout as backup (will be lost on service worker restart)
        if (scheduleWakeUpTimer) {
            clearTimeout(scheduleWakeUpTimer);
        }
        scheduleWakeUpTimer = setTimeout(async () => {
            console.log('⏰ Backup timer triggered for morning restart');
            await handleMorningRestart();
        }, timeUntilRestart);
        
    } catch (error) {
        console.error('❌ Error scheduling next day restart:', error);
    }
}

// Check and restore next-day restart timer after browser restart
// Also checks for missed alarms and triggers immediately if needed
async function checkAndRestoreNextDayTimer() {
    try {
        console.log('🔍 Checking for morning restart status...');
        
        const data = await chrome.storage.local.get(['nextDayRestartTime', 'restartReason', 'lastRunDate', 'lastScheduledDate']);
        const today = new Date().toDateString();
        const now = new Date();
        
        // Check if alarm exists
        const alarms = await chrome.alarms.getAll();
        const morningAlarm = alarms.find(a => a.name === 'morningRestart');
        
        console.log('Morning restart check:', {
            hasAlarm: !!morningAlarm,
            alarmTime: morningAlarm ? new Date(morningAlarm.scheduledTime).toLocaleString() : 'none',
            storedRestartTime: data.nextDayRestartTime,
            lastRunDate: data.lastRunDate,
            lastScheduledDate: data.lastScheduledDate,
            today: today,
            isNewDay: data.lastRunDate !== today
        });
        
        // If it's a new day and we haven't run today
        if (data.lastRunDate !== today && data.nextDayRestartTime) {
            const restartTime = new Date(data.nextDayRestartTime);
            
            // If scheduled restart time has passed, we missed it!
            if (restartTime <= now) {
                console.log('⏰ MISSED MORNING RESTART DETECTED! Starting now...');
                
                // Clear old data and alarm
                await chrome.storage.local.remove(['nextDayRestartTime', 'restartReason']);
                await chrome.alarms.clear('morningRestart');
                
                // Check if we should start now
                const isWithin = await isWithinSchedule();
                if (isWithin) {
                    console.log('🚀 Within schedule, triggering missed morning restart...');
                    await handleMorningRestart();
                    return; // Exit early, we've handled it
                } else {
                    console.log('🔘 Outside schedule, will wait for proper time');
                    setBadge(new GreyBadge());
                }
            }
        }
        
        // Continue with normal restoration logic
        if (data.nextDayRestartTime) {
            const restartTime = new Date(data.nextDayRestartTime);
            
            console.log('Found saved restart time:', {
                restartTime: restartTime.toLocaleString(),
                reason: data.restartReason,
                isInFuture: restartTime > now
            });
            
            if (restartTime > now) {
                // Timer is still valid, restore it
                const timeUntilRestart = restartTime - now;
                console.log(`Restoring next day restart timer: ${Math.round(timeUntilRestart/1000/60/60)} hours remaining`);
                
                scheduleWakeUpTimer = setTimeout(async () => {
                    console.log('Executing restored next day restart...');
                    
                    // Reset all systems for the new day
                    if (searchQuest) searchQuest.reset();
                    if (userDailyStatus) userDailyStatus.reset();
                    if (googleTrend) googleTrend.reset();
                    
                    // Clear pause state
                    isSchedulePaused = false;
                    await chrome.storage.local.set({
                        'scheduleState': 'active',
                        'isSchedulePaused': false
                    });
                    
                    // Check if we're within schedule before starting
                    const isWithin = await isWithinSchedule();
                    if (isWithin) {
                        console.log('Within schedule, starting searches for new day...');
                        setBadge(new BusyBadge());
                        setTimeout(() => {
                            doBackgroundWork('nextDayRestart');
                        }, 2000);
                    } else {
                        console.log('Outside schedule, setting gray badge and waiting for schedule');
                        setBadge(new GreyBadge());
                        // Let the schedule system handle when to start
                    }
                    
                    // Clean up storage
                    await chrome.storage.local.remove(['nextDayRestartTime', 'restartReason']);
                    
                }, timeUntilRestart);
                
            } else {
                // Timer has passed, clean up and trigger restart immediately if appropriate
                console.log('Restart time has passed, cleaning up and checking if restart is needed');
                await chrome.storage.local.remove(['nextDayRestartTime', 'restartReason']);
                
                // Check if we should start searches now
                const isWithin = await isWithinSchedule();
                if (isWithin) {
                    console.log('Within schedule, starting searches now');
                    setBadge(new BusyBadge());
                    setTimeout(() => {
                        doBackgroundWork('nextDayRestart');
                    }, 5000); // 5 second delay for initialization
                } else {
                    console.log('Outside schedule, setting gray badge and waiting');
                    setBadge(new GreyBadge());
                }
            }
        }
    } catch (error) {
        console.error('Error checking/restoring next day timer:', error);
    }
}

async function isWithinSchedule() {
    const settings = await chrome.storage.sync.get({
        'enableSchedule': false,
        'startTime': '09:00',
        'endTime': '17:00'
    });

    if (!settings.enableSchedule) {
        return true; // If scheduling is disabled, always return true
    }

    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();
    
    const [startHour, startMinute] = settings.startTime.split(':').map(Number);
    const [endHour, endMinute] = settings.endTime.split(':').map(Number);
    const startTime = startHour * 60 + startMinute;
    const endTime = endHour * 60 + endMinute;

    let isWithin;
    
    // Handle both normal and overnight schedules
    if (startTime <= endTime) {
        // Normal schedule (e.g., 09:00-17:00)
        isWithin = currentTime >= startTime && currentTime < endTime;
    } else {
        // Overnight schedule (e.g., 22:00-06:00)
        isWithin = currentTime >= startTime || currentTime < endTime;
    }

    debugLog(`Schedule check: ${Math.floor(currentTime/60)}:${(currentTime%60).toString().padStart(2, '0')} in range ${settings.startTime}-${settings.endTime}: ${isWithin}`, LOG_LEVELS.INFO);
    
    return isWithin;
}

// Enhanced scheduling system with persistence and recovery
async function initializeScheduleSystem() {
    console.log('Initializing robust scheduling system...');
    
    try {
        // Get current schedule settings
        const settings = await chrome.storage.sync.get({
            'enableSchedule': false,
            'startTime': '09:00',
            'endTime': '17:00'
        });
        
        console.log('Schedule settings:', settings);
        
        if (!settings.enableSchedule) {
            console.log('Scheduling disabled, clearing any existing timers');
            clearAllScheduleTimers();
            isSchedulePaused = false; // Ensure we're not paused if scheduling is disabled
            // Still return true to allow regular work scheduling
            return true;
        }
        
        // Check for existing persistent state
        const persistentState = await chrome.storage.local.get([
            'scheduleState',
            'nextWakeUpTime',
            'isSchedulePaused',
            'lastScheduleCheck'
        ]);
        
        console.log('Persistent state:', persistentState);
        
        // Restore state if valid
        if (persistentState.scheduleState) {
            console.log('Restoring schedule state:', persistentState.scheduleState);
            isSchedulePaused = persistentState.isSchedulePaused || false;
        }
        
        // Check current schedule state
        console.log('Checking current schedule state...');
        await checkCurrentScheduleState();
        
        console.log('Schedule system initialization completed');
        
    } catch (error) {
        console.error('Error initializing schedule system:', error);
    }
}

async function checkCurrentScheduleState() {
    console.log('=== SCHEDULE STATE CHECK DEBUG ===');
    console.log('Checking current schedule state...');
    
    const settings = await chrome.storage.sync.get({
        'enableSchedule': false,
        'startTime': '09:00',
        'endTime': '17:00'
    });
    
    console.log('Schedule settings loaded:', settings);
    
    if (!settings.enableSchedule) {
        console.log('✅ Schedule disabled, returning true (always allow)');
        return true; // Always allow if scheduling disabled
    }
    
    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();
    
    const [startHour, startMinute] = settings.startTime.split(':').map(Number);
    const [endHour, endMinute] = settings.endTime.split(':').map(Number);
    const startTime = startHour * 60 + startMinute;
    const endTime = endHour * 60 + endMinute;
    
    const isWithinSchedule = (startTime <= endTime) 
        ? (currentTime >= startTime && currentTime < endTime)
        : (currentTime >= startTime || currentTime < endTime);
    
    console.log('Schedule calculation:', {
        currentTime: `${Math.floor(currentTime/60)}:${(currentTime%60).toString().padStart(2, '0')}`,
        scheduleWindow: `${settings.startTime}-${settings.endTime}`,
        startTime: startTime,
        endTime: endTime,
        isWithinSchedule,
        isCurrentlyPaused: isSchedulePaused
    });
    
    if (isWithinSchedule && isSchedulePaused) {
        // We're in schedule and were paused - resume
        console.log('📅 Within schedule but currently paused - resuming');
        await resumeFromSchedulePause();
    } else if (!isWithinSchedule && !isSchedulePaused) {
        // We're outside schedule and not paused - pause
        console.log('📅 Outside schedule and not paused - pausing');
        await pauseForSchedule();
    } else if (isWithinSchedule && !isSchedulePaused) {
        // We're within schedule and not paused - this is normal, no action needed
        console.log('📅 Within schedule and not paused - state is correct');
    } else {
        // We're outside schedule and already paused - this is normal, no action needed
        console.log('📅 Outside schedule and paused - state is correct');
    }
    
    // Always schedule the next state change
    await scheduleNextStateChange(settings);
    
    console.log('=== SCHEDULE STATE CHECK RESULT ===', { isWithinSchedule });
    return isWithinSchedule;
}

async function pauseForSchedule() {
    console.log('Pausing searches due to schedule...');
    
    isSchedulePaused = true;
    
    // Save persistent state
    await chrome.storage.local.set({
        'scheduleState': 'paused',
        'isSchedulePaused': true,
        'pausedAt': new Date().toISOString(),
        'pauseReason': 'schedule'
    });
    
    // If searches are currently running, stop them
    if (searchQuest && searchQuest.jobStatus === STATUS_BUSY) {
        console.log('Stopping active searches for schedule pause');
        searchQuest._pausedBySchedule = true;
        
        if (typeof searchQuest.forceStop === 'function') {
            await searchQuest.forceStop();
        } else {
            searchQuest._jobStatus_ = STATUS_DONE;
        }
    }
    
    // Clear regular work timers
    if (workIntervalId) {
        clearInterval(workIntervalId);
        workIntervalId = null;
    }
    
    // Set appropriate badge (gray when outside schedule)
    console.log('🎨 Setting gray badge - outside schedule window');
    setBadge(new GreyBadge());
    
    // Send notification
    try {
        await chrome.notifications.create('schedule-paused', {
            type: 'basic',
            iconUrl: 'img/off@8x.png',
            title: 'Searches Paused',
            message: 'Searches paused due to schedule. Will resume at next start time.',
            priority: 1
        });
    } catch (error) {
        console.log('Notification failed (may be disabled):', error.message);
    }
    
    console.log('Schedule pause complete');
}

async function resumeFromSchedulePause() {
    console.log('Resuming searches from schedule pause...');
    
    isSchedulePaused = false;
    
    // Clear persistent pause state
    await chrome.storage.local.set({
        'scheduleState': 'active',
        'isSchedulePaused': false,
        'pausedAt': null,
        'pauseReason': null,
        'lastResumeTime': new Date().toISOString()
    });
    
    // Determine proper badge state before resuming
    try {
        await checkDailyRewardStatus();
        const availablePoints = userDailyStatus?.summary?.availablePoints || 0;
        const areSearchesCompleted = 
            (userDailyStatus?.pcSearchStatus?.isCompleted || !userDailyStatus?.pcSearchStatus?.isValid) && 
            (userDailyStatus?.mbSearchStatus?.isCompleted || !userDailyStatus?.mbSearchStatus?.isValid);
        
        if (areSearchesCompleted && availablePoints === 0) {
            console.log('🎨 Searches already complete, setting done badge');
            setBadge(new DoneBadge());
        } else {
            console.log('🎨 Searches need work, setting busy badge for upcoming work');
            setBadge(new BusyBadge());
        }
    } catch (error) {
        console.log('Error checking status during resume, defaulting to grey badge:', error);
        setBadge(new GreyBadge());
    }
    
    // Resume search quest if it was paused
    if (searchQuest && searchQuest._pausedBySchedule) {
        console.log('Resuming search quest from schedule pause');
        // Use the proper resume method instead of direct property assignment
        searchQuest.resume();
        searchQuest._pausedBySchedule = false;
        
        // Only start searches if they're not already complete
        const availablePoints = userDailyStatus?.summary?.availablePoints || 0;
        const areSearchesCompleted = 
            (userDailyStatus?.pcSearchStatus?.isCompleted || !userDailyStatus?.pcSearchStatus?.isValid) && 
            (userDailyStatus?.mbSearchStatus?.isCompleted || !userDailyStatus?.mbSearchStatus?.isValid);
        
        if (!areSearchesCompleted || availablePoints > 0) {
            console.log('Will start searches after schedule resume - work needed');
            // doBackgroundWork will be called below
        } else {
            console.log('Searches already complete, no need to start');
            return; // Exit early, don't start background work
        }
    }
    
    // Send notification
    try {
        await chrome.notifications.create('schedule-resumed', {
            type: 'basic',
            iconUrl: 'img/bingRwLogo@8x.png',
            title: 'Searches Resumed',
            message: 'Searches resumed - now within scheduled hours.',
            priority: 1
        });
    } catch (error) {
        console.log('Notification failed (may be disabled):', error.message);
    }
    
    // Start background work with a small delay
    console.log('Scheduling background work after resume');
    setTimeout(() => {
        doBackgroundWork('scheduleResume');
    }, 5000);
    
    console.log('Schedule resume complete');
}

async function setInitialBadgeState() {
    console.log('Setting initial badge state based on current conditions...');
    
    try {
        // Check if we're within schedule
        const isWithin = await isWithinSchedule();
        
        if (!isWithin) {
            console.log('Outside schedule window, setting gray badge');
            setBadge(new GreyBadge());
            return;
        }
        
        // We're within schedule, check completion status
        // Note: Don't call checkDailyRewardStatus() again as it was already called in doBackgroundWork
        const availablePoints = userDailyStatus?.summary?.availablePoints || 0;
        const areSearchesCompleted = 
            (userDailyStatus?.pcSearchStatus?.isCompleted || !userDailyStatus?.pcSearchStatus?.isValid) && 
            (userDailyStatus?.mbSearchStatus?.isCompleted || !userDailyStatus?.mbSearchStatus?.isValid);
        
        // Check if searches are currently running
        const isCurrentlyBusy = searchQuest && searchQuest.jobStatus === STATUS_BUSY;
        
        if (areSearchesCompleted && availablePoints === 0) {
            console.log('Searches already complete, setting done badge');
            setBadge(new DoneBadge());
        } else if (isCurrentlyBusy) {
            console.log('Searches currently running, setting busy badge');
            setBadge(new BusyBadge());
        } else {
            console.log('Searches needed but not currently running, setting gray badge');
            setBadge(new GreyBadge());
        }
        
    } catch (error) {
        console.log('Error determining initial badge state, defaulting to gray:', error);
        setBadge(new GreyBadge());
    }
}

async function scheduleNextStateChange(settings) {
    console.log('Scheduling next state change...');
    
    const now = new Date();
    const [startHour, startMinute] = settings.startTime.split(':').map(Number);
    const [endHour, endMinute] = settings.endTime.split(':').map(Number);
    
    let nextChangeTime;
    let nextAction;
    
    const currentTime = now.getHours() * 60 + now.getMinutes();
    const startTime = startHour * 60 + startMinute;
    const endTime = endHour * 60 + endMinute;
    
    const isWithinSchedule = (startTime <= endTime) 
        ? (currentTime >= startTime && currentTime < endTime)
        : (currentTime >= startTime || currentTime < endTime);
    
    if (isWithinSchedule) {
        // Currently within schedule, next change is end time
        nextChangeTime = new Date();
        nextChangeTime.setHours(endHour, endMinute, 0, 0);
        
        // If end time is tomorrow (for overnight schedules)
        if (startTime > endTime && currentTime >= startTime) {
            nextChangeTime.setDate(nextChangeTime.getDate() + 1);
        }
        
        nextAction = 'pause';
    } else {
        // Currently outside schedule, next change is start time
        nextChangeTime = new Date();
        nextChangeTime.setHours(startHour, startMinute, 0, 0);
        
        // If start time has passed today, schedule for tomorrow
        if (nextChangeTime <= now) {
            nextChangeTime.setDate(nextChangeTime.getDate() + 1);
        }
        
        nextAction = 'resume';
    }
    
    const timeUntilChange = nextChangeTime - now;
    
    console.log(`Next schedule change: ${nextAction} at ${nextChangeTime.toLocaleTimeString()} (in ${Math.round(timeUntilChange/60000)} minutes)`);
    
    // Save persistent state
    await chrome.storage.local.set({
        'nextWakeUpTime': nextChangeTime.toISOString(),
        'nextScheduleAction': nextAction,
        'lastScheduleCheck': now.toISOString()
    });
    
    // Clear existing timer
    if (scheduleWakeUpTimer) {
        clearTimeout(scheduleWakeUpTimer);
    }
    
    // Schedule the wake-up
    scheduleWakeUpTimer = setTimeout(async () => {
        console.log(`Executing scheduled ${nextAction} at ${new Date().toLocaleTimeString()}`);
        await handleScheduledWakeUp(nextAction);
    }, timeUntilChange);
}

async function handleScheduledWakeUp(action) {
    console.log(`Handling scheduled wake-up: ${action}`);
    
    try {
        if (action === 'resume') {
            console.log('📅 Schedule resuming - checking current state and starting if needed');
            await resumeFromSchedulePause();
        } else if (action === 'pause') {
            console.log('📅 Schedule pausing - switching to gray badge');
            await pauseForSchedule();
        }
        
        // Schedule the next state change
        const settings = await chrome.storage.sync.get({
            'enableSchedule': false,
            'startTime': '09:00',
            'endTime': '17:00'
        });
        
        if (settings.enableSchedule) {
            await scheduleNextStateChange(settings);
        }
        
    } catch (error) {
        console.error('Error in scheduled wake-up:', error);
    }
}

function clearAllScheduleTimers() {
    console.log('Clearing all schedule timers');
    
    if (scheduleWakeUpTimer) {
        clearTimeout(scheduleWakeUpTimer);
        scheduleWakeUpTimer = null;
    }
    
    if (scheduledWorkTimer) {
        clearTimeout(scheduledWorkTimer);
        scheduledWorkTimer = null;
    }
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
    console.log('=== BACKGROUND WORK DEBUG START ===');
    console.log('Background work starting...');
    
    // Enhanced logging for debugging wake-up issues
    console.log('Current state check:', {
        searchQuestStatus: searchQuest?.jobStatus,
        isPausedBySchedule: searchQuest?._pausedBySchedule,
        userDailyStatusBusy: userDailyStatus?.jobStatus === STATUS_BUSY,
        isSchedulePaused: isSchedulePaused,
        timestamp: new Date().toLocaleTimeString()
    });
    
    // Check if we're paused by schedule
    if (isSchedulePaused) {
        console.log('❌ BLOCKED: Currently paused by schedule, skipping background work');
        return;
    }
    console.log('✅ PASSED: Schedule pause check');
    
    // Add guard against rapid retries (but allow manual starts and initialization to bypass this)
    const lastWorkTime = await chrome.storage.local.get('lastWorkAttempt');
    const now = Date.now();
    
    // Check if this is a manual start or initialization by looking at the call stack or a flag
    const isManualStart = arguments.length > 0 && arguments[0] === 'manualStart';
    const isInitialization = arguments.length > 0 && arguments[0] === 'initialization';
    const isScheduleResume = arguments.length > 0 && arguments[0] === 'scheduleResume';
    const isNextDayRestart = arguments.length > 0 && arguments[0] === 'nextDayRestart';
    const isPointsBasedRestart = arguments.length > 0 && arguments[0] === 'pointsBasedRestart';
    const shouldBypassRapidRetry = isManualStart || isInitialization || isScheduleResume || isNextDayRestart || isPointsBasedRestart;
    
    if (lastWorkTime.lastWorkAttempt && !shouldBypassRapidRetry) {
        const timeSinceLastWork = now - lastWorkTime.lastWorkAttempt;
        const MINIMUM_WORK_INTERVAL = 30000; // 30 seconds minimum between attempts
        
        if (timeSinceLastWork < MINIMUM_WORK_INTERVAL) {
            console.log(`❌ BLOCKED: Too soon to retry work (${Math.round(timeSinceLastWork/1000)}s < ${MINIMUM_WORK_INTERVAL/1000}s), skipping...`);
            return;
        }
    }
    
    if (isManualStart) {
        console.log('✅ BYPASSED: Rapid retry check for manual start');
    } else if (isInitialization) {
        console.log('✅ BYPASSED: Rapid retry check for initialization');
    } else if (isScheduleResume) {
        console.log('✅ BYPASSED: Rapid retry check for schedule resume');
    } else if (isNextDayRestart) {
        console.log('✅ BYPASSED: Rapid retry check for next day restart');
    } else if (isPointsBasedRestart) {
        console.log('✅ BYPASSED: Rapid retry check for points-based restart');
    } else {
        console.log('✅ PASSED: Rapid retry check');
    }
    
    // Store this attempt time
    await chrome.storage.local.set({ lastWorkAttempt: now });
    
    // Check day change first
    await checkDayChange();
    
    // Update daily reset 
    checkNewDay();
    
    // Check schedule using the new system (this handles pausing/resuming automatically)
    console.log('About to call checkCurrentScheduleState()...');
    const withinSchedule = await checkCurrentScheduleState();
    console.log('Schedule check result:', { withinSchedule });
    
    if (!withinSchedule) {
        console.log('❌ BLOCKED: Outside scheduled hours, work handled by scheduling system');
        return;
    }
    console.log('✅ PASSED: Schedule check');
    
    // Check for connectivity before proceeding
    console.log('Checking connectivity...');
    await waitTillOnline();
    console.log('✅ PASSED: Connectivity check');
    
    // Add guard against parallel execution
    if (searchQuest.jobStatus === STATUS_BUSY || userDailyStatus.jobStatus === STATUS_BUSY) {
        console.log('❌ BLOCKED: Work already in progress, skipping...', {
            searchQuestBusy: searchQuest.jobStatus === STATUS_BUSY,
            userDailyStatusBusy: userDailyStatus.jobStatus === STATUS_BUSY
        });
        return;
    }
    console.log('✅ PASSED: Parallel execution check');

    // Special handling for wake-up scenarios - if searches were paused and we're now in a DONE state,
    // but it's been a while since last work, consider restarting
    const pauseData = await chrome.storage.local.get(['searchPausedAt', 'lastWorkAttempt']);
    const isScheduleResumeCheck = arguments.length > 0 && arguments[0] === 'scheduleResume';
    const isNextDayRestartCheck = arguments.length > 0 && arguments[0] === 'nextDayRestart';
    const isPointsBasedRestartCheck = arguments.length > 0 && arguments[0] === 'pointsBasedRestart';
    
    if (pauseData.searchPausedAt && searchQuest.jobStatus === STATUS_DONE) {
        const pausedAt = new Date(pauseData.searchPausedAt);
        const timeSincePause = now - pausedAt.getTime();
        
        // If it's been more than 5 minutes since pause OR this is a special restart, consider a fresh restart
        const shouldRestart = timeSincePause > 5 * 60 * 1000 || isScheduleResumeCheck || isNextDayRestartCheck || isPointsBasedRestartCheck;
        
        if (shouldRestart) {
            console.log('Pause detected, forcing fresh restart of search quest', {
                pausedAt: pausedAt.toLocaleTimeString(),
                timeSincePauseMinutes: Math.round(timeSincePause / 60000),
                isScheduleResume: isScheduleResumeCheck,
                isNextDayRestart: isNextDayRestartCheck,
                isPointsBasedRestart: isPointsBasedRestartCheck,
                reason: isScheduleResumeCheck ? 'schedule resume' : 
                       isNextDayRestartCheck ? 'next day restart' : 
                       isPointsBasedRestartCheck ? 'points-based restart' : 'long pause'
            });
            
            // Reset the search quest to allow fresh work
            searchQuest.resume();
            
            // Clear the pause timestamp since we're restarting
            await chrome.storage.local.remove('searchPausedAt');
        }
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
            // Check if searches are completed based on boolean flags
            const areSearchesCompleted = 
                (userDailyStatus?.pcSearchStatus?.isCompleted || !userDailyStatus?.pcSearchStatus?.isValid) && 
                (userDailyStatus?.mbSearchStatus?.isCompleted || !userDailyStatus?.mbSearchStatus?.isValid);
            
            // Check if we actually have 0 points remaining (true completion)
            const availablePoints = userDailyStatus?.summary?.availablePoints || 0;
            const areTrulyCompleted = areSearchesCompleted && availablePoints === 0;
            
            // Check if we performed any searches in this run
            const didSearchesThisRun = 
                (!initialPcCompleted && userDailyStatus?.pcSearchStatus?.isCompleted) ||
                (!initialMbCompleted && userDailyStatus?.mbSearchStatus?.isCompleted);
                
            // Only allow the badge to turn green if the extension has been running for a minimum time
            const canShowDone = runtimeMs >= MIN_RUNTIME_BEFORE_DONE;
                
            console.log('Search completion status for badge decision:', {
                areSearchesCompleted: areSearchesCompleted,
                availablePoints: availablePoints,
                areTrulyCompleted: areTrulyCompleted,
                didSearchesThisRun: didSearchesThisRun,
                searchQuestStatus: searchQuest.jobStatus,
                runtimeMs: runtimeMs,
                canShowDone: canShowDone
            });
            
            // If searches show complete but we still have points, restart a cycle
            if (areSearchesCompleted && availablePoints > 0 && canShowDone) {
                console.log(`Searches marked complete but ${availablePoints} points remaining - starting another cycle`);
                
                // Send notification about additional cycle
                try {
                    await chrome.notifications.create('additional-cycle', {
                        type: 'basic',
                        iconUrl: 'img/bingRwLogo@8x.png',
                        title: 'Additional Search Cycle',
                        message: `${availablePoints} points remaining. Running additional searches.`,
                        priority: 1
                    });
                } catch (error) {
                    console.log('Notification failed (may be disabled):', error.message);
                }
                
                // Reset search completion flags to allow another cycle
                if (userDailyStatus?.pcSearchStatus) {
                    userDailyStatus.pcSearchStatus.isCompleted = false;
                }
                if (userDailyStatus?.mbSearchStatus) {
                    userDailyStatus.mbSearchStatus.isCompleted = false;
                }
                
                // Reset search quest to allow fresh work
                if (searchQuest) {
                    searchQuest.resume();
                    console.log('Search quest reset for additional cycle');
                }
                
                // Continue with busy badge and restart searches
                setTimeout(() => {
                    console.log('Starting additional search cycle to earn remaining points');
                    doBackgroundWork('pointsBasedRestart');
                }, 5000); // 5 second delay
                
                return; // Exit early to avoid setting done badge
            }
            
            if (areTrulyCompleted && canShowDone) {
                console.log('All searches are truly completed (0 points remaining) and minimum runtime reached, setting badge to done');
                setBadge(new DoneBadge());
                
                // Send completion notification with actual daily max reached
                try {
                    const totalPoints = userDailyStatus?.summary?.searchPointsEarned || 0;
                    const maxDailyPoints = userDailyStatus?.summary?.maxDailySearchPoints || 150;
                    
                    await chrome.notifications.create('searches-complete', {
                        type: 'basic',
                        iconUrl: 'img/bingRwLogo@8x.png',
                        title: 'Daily Searches Complete! 🎉',
                        message: `Reached maximum ${maxDailyPoints} search points for the day! (${totalPoints}/${maxDailyPoints})`,
                        priority: 2
                    });
                } catch (error) {
                    console.log('Completion notification failed (may be disabled):', error.message);
                }
                
                // Schedule automatic restart for next day
                await scheduleNextDayRestart();
            } else if (areTrulyCompleted && !canShowDone) {
                console.log('Searches truly completed but not showing done badge yet (runtime < minimum)');
                // Schedule a timeout to set the done badge after minimum runtime
                const remainingTime = MIN_RUNTIME_BEFORE_DONE - runtimeMs;
                console.log(`Will set done badge after ${Math.round(remainingTime/1000)} more seconds`);
                
                // Keep busy badge for now
                setTimeout(async () => {
                    // Double check that conditions are still true
                    const currentAvailablePoints = userDailyStatus?.summary?.availablePoints || 0;
                    if (areTrulyCompleted && currentAvailablePoints === 0 && !searchQuest.jobStatus === STATUS_BUSY) {
                        console.log('Setting delayed done badge after minimum runtime');
                        setBadge(new DoneBadge());
                        
                        // Schedule automatic restart for next day
                        await scheduleNextDayRestart();
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
                
                // Clear old schedule and force new one for today
                console.log('Clearing old schedule data due to day change...');
                await chrome.storage.local.remove(['nextRegularWorkTime', 'lastWorkAttempt']);
                
                // Force a new schedule
                console.log('Scheduling new work for today...');
                scheduleNextWork();
                
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
            const searchEndMinutes = searchEndTime.getHours() * 60 + searchEndTime.getMinutes();
            
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
chrome.runtime.onStartup.addListener(async () => {
    console.log('🔄 Chrome startup detected at ' + new Date().toLocaleString());
    
    // Ensure periodic check alarm exists
    const alarms = await chrome.alarms.getAll();
    if (!alarms.find(a => a.name === 'periodicCheck')) {
        console.log('⚠️ Periodic check alarm missing, recreating...');
        await chrome.alarms.create('periodicCheck', {
            periodInMinutes: 60,
            delayInMinutes: 1
        });
    }
    
    // Immediately check for new day
    await checkForMissedMorningStart();
    
    // Check for missed morning restart BEFORE regular initialization
    try {
        await checkAndRestoreNextDayTimer();
    } catch (error) {
        console.error('Error checking missed morning restart:', error);
    }
    
    onExtensionLoad();
});

// Add a way to force work to start immediately for debugging
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Message received:', message);
    
    // Handle async operations properly
    const handleMessage = async () => {
        try {
            switch (message.action) {
                case 'checkMissedMorningStart':
                    console.log('🔍 Popup opened - checking for missed morning start...');
                    
                    // Run the periodic check immediately
                    checkForMissedMorningStart().then(() => {
                        sendResponse({success: true});
                    }).catch(error => {
                        console.error('Error checking missed morning start:', error);
                        sendResponse({success: false, error: error.message});
                    });
                    
                    return true; // Keep message channel open for async response
                    
                case 'startSearches':
                    console.log('=== MANUAL START SEARCHES DEBUG ===');
                    console.log('Manually starting searches - initial state:', {
                        isSchedulePaused,
                        searchQuestStatus: searchQuest?.jobStatus,
                        userDailyStatusBusy: userDailyStatus?.jobStatus,
                        timestamp: new Date().toLocaleTimeString()
                    });
                    
                    // Clear any next-day restart timer since user is manually starting
                    if (scheduleWakeUpTimer) {
                        clearTimeout(scheduleWakeUpTimer);
                        scheduleWakeUpTimer = null;
                        console.log('Cleared next-day restart timer due to manual start');
                    }
                    await chrome.storage.local.remove(['nextDayRestartTime', 'restartReason']);
                    
                    // For manual starts, temporarily bypass schedule pause
                    const wasSchedulePaused = isSchedulePaused;
                    if (isSchedulePaused) {
                        console.log('Temporarily bypassing schedule pause for manual start');
                        isSchedulePaused = false;
                    }
                
                // Also ensure search quest is not stuck in DONE state
                if (searchQuest && searchQuest.jobStatus === STATUS_DONE) {
                    console.log('Resetting search quest from DONE to NONE for manual start');
                    searchQuest.jobStatus = STATUS_NONE;
                }
                
                console.log('About to call doBackgroundWork() with state:', {
                    isSchedulePaused,
                    searchQuestStatus: searchQuest?.jobStatus,
                    userDailyStatusBusy: userDailyStatus?.jobStatus
                });
                
                doBackgroundWork('manualStart').then((result) => {
                    console.log('Manual doBackgroundWork completed, result:', result);
                    sendResponse({success: true, message: 'Search work started'});
                }).catch(error => {
                    console.error('Manual doBackgroundWork failed:', error);
                    sendResponse({success: false, error: error.message});
                }).finally(() => {
                    // Restore original pause state after attempt
                    isSchedulePaused = wasSchedulePaused;
                    console.log('Restored original schedule pause state:', isSchedulePaused);
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
                        nextSearchTerm: (typeof searchInfo.nextSearchTerm === 'string') ? searchInfo.nextSearchTerm : '[next term]',
                        nextSearchTime: searchInfo.nextSearchTime || null
                    });
                } else {
                    // Even when not in progress, get terms for display from googleTrend
                    let nextTerm = '';
                    try {
                        if (googleTrend) {
                            // Handle async call with Promise
                            googleTrend.getNextTermForDisplayAsync('PC').then(term => {
                                // Ensure we always have a string
                                nextTerm = (typeof term === 'string') ? term : '[next term]';
                                
                                console.log('Search not in progress. Next term:', nextTerm);
                                
                                sendResponse({
                                    success: true,
                                    inProgress: false,
                                    nextSearchTerm: nextTerm
                                });
                            }).catch(err => {
                                console.warn('Error getting next term:', err);
                                nextTerm = '[next term]';
                                
                                sendResponse({
                                    success: true,
                                    inProgress: false,
                                    nextSearchTerm: nextTerm
                                });
                            });
                            return true; // Keep message channel open for async response
                        } else {
                            // No googleTrend available
                            sendResponse({
                                success: true,
                                inProgress: false,
                                nextSearchTerm: '[next term]'
                            });
                        }
                    } catch (err) {
                        console.warn('Error getting next term:', err);
                        sendResponse({
                            success: true,
                            inProgress: false,
                            nextSearchTerm: '[next term]'
                        });
                    }
                }
                break;
                
            case 'getNextScheduledTime':
                // Get next scheduled time from the new scheduling system
                chrome.storage.local.get([
                    'nextWakeUpTime',
                    'nextRegularWorkTime',
                    'isSchedulePaused'
                ]).then(data => {
                    let nextTime = null;
                    const now = new Date();
                    
                    // If we're paused by schedule, return the wake-up time
                    if (isSchedulePaused && data.nextWakeUpTime) {
                        nextTime = data.nextWakeUpTime;
                    } 
                    // Otherwise, return the next regular work time
                    else if (data.nextRegularWorkTime) {
                        const scheduledTime = new Date(data.nextRegularWorkTime);
                        
                        // Check if the scheduled time is in the past
                        if (scheduledTime < now) {
                            console.log('Scheduled time is in the past, forcing schedule refresh...');
                            // Force a new schedule to be created
                            scheduleNextWork().then(() => {
                                // Get the updated time
                                chrome.storage.local.get(['nextRegularWorkTime']).then(updatedData => {
                                    console.log('Updated next work time:', updatedData.nextRegularWorkTime);
                                    sendResponse({
                                        success: true,
                                        nextScheduledTime: updatedData.nextRegularWorkTime,
                                        isSchedulePaused: isSchedulePaused
                                    });
                                });
                            }).catch(error => {
                                console.error('Error refreshing schedule:', error);
                                sendResponse({
                                    success: false,
                                    error: error.message
                                });
                            });
                            return; // Exit early, response will be sent above
                        }
                        
                        nextTime = data.nextRegularWorkTime;
                    }
                    
                    console.log('getNextScheduledTime response:', {
                        nextTime,
                        isSchedulePaused,
                        nextWakeUpTime: data.nextWakeUpTime,
                        nextRegularWorkTime: data.nextRegularWorkTime
                    });
                    
                    sendResponse({
                        success: true,
                        nextScheduledTime: nextTime,
                        isSchedulePaused: isSchedulePaused
                    });
                }).catch(error => {
                    console.error('Error getting next scheduled time:', error);
                    sendResponse({
                        success: false,
                        error: error.message
                    });
                });
                return true; // Keep message channel open for async response
                
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
                
            case 'searchProgressUpdate':
                // Handle periodic progress updates from search quest
                console.log('Search progress update received:', message.content);
                // Forward to all popup instances
                chrome.runtime.sendMessage({
                    action: 'searchProgressUpdate',
                    content: message.content
                }).catch(err => {
                    // Ignore errors - popups might not be open
                    console.log('No popup to receive progress update');
                });
                sendResponse({success: true});
                break;
                
            case 'searchStarting':
                // Handle search starting notifications
                console.log('Search starting notification:', message.content);
                // Forward to popup
                chrome.runtime.sendMessage({
                    action: 'searchStarting',
                    content: message.content
                }).catch(err => {
                    console.log('No popup to receive search starting notification');
                });
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
                
            case 'updateSearchSettings':
                // Handle search settings updates
                console.log('Search settings updated:', message.content);
                try {
                    // Reload settings if they've changed
                    loadSavedSettings();
                    
                    // Reset any cached search settings for the new day
                    if (searchQuest) {
                        searchQuest._targetSearchCount = null; // Force recalculation
                    }
                    
                    // If schedule settings changed, reinitialize the scheduling system
                    if (message.content && message.content.scheduleChanged) {
                        console.log('Schedule settings changed, reinitializing schedule system');
                        initializeScheduleSystem().then(() => {
                            console.log('Schedule system reinitialized');
                        }).catch(error => {
                            console.error('Error reinitializing schedule system:', error);
                        });
                    }
                    
                    sendResponse({
                        success: true,
                        message: 'Search settings updated successfully'
                    });
                } catch (error) {
                    console.error('Error updating search settings:', error);
                    sendResponse({
                        success: false,
                        error: error.message || 'Error updating search settings'
                    });
                }
                break;
                
            case 'skipCurrentSearch':
                // Handle skip current search request
                console.log('Skip current search requested');
                try {
                    if (searchQuest && searchQuest.jobStatus === STATUS_BUSY) {
                        searchQuest.skipCurrentSearch();
                        sendResponse({
                            success: true,
                            message: 'Current search term skipped'
                        });
                    } else {
                        sendResponse({
                            success: false,
                            error: 'No search in progress to skip'
                        });
                    }
                } catch (error) {
                    console.error('Error skipping search:', error);
                    sendResponse({
                        success: false,
                        error: error.message || 'Error skipping search'
                    });
                }
                break;
                
            case 'forceNextSearch':
                // Handle force next search request
                console.log('Force next search requested');
                try {
                    if (searchQuest && searchQuest.jobStatus === STATUS_BUSY) {
                        searchQuest.forceNextSearch();
                        sendResponse({
                            success: true,
                            message: 'Forced to next search'
                        });
                    } else {
                        sendResponse({
                            success: false,
                            error: 'No search in progress to force'
                        });
                    }
                } catch (error) {
                    console.error('Error forcing next search:', error);
                    sendResponse({
                        success: false,
                        error: error.message || 'Error forcing next search'
                    });
                }
                break;
                
            case 'stopSearches':
                // Handle stop searches request
                console.log('Stop searches requested');
                try {
                    if (searchQuest) {
                        // Stop the current search quest
                        searchQuest.forceStop().then(() => {
                            sendResponse({
                                success: true,
                                message: 'Searches stopped until manually restarted'
                            });
                        }).catch(error => {
                            console.error('Error stopping searches:', error);
                            sendResponse({
                                success: false,
                                error: error.message || 'Error stopping searches'
                            });
                        });
                        // Return true to indicate async response
                        return true;
                    } else {
                        sendResponse({
                            success: false,
                            error: 'No search quest available to stop'
                        });
                    }
                } catch (error) {
                    console.error('Error stopping searches:', error);
                    sendResponse({
                        success: false,
                        error: error.message || 'Error stopping searches'
                    });
                }
                break;
                
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
};

// Call the async handler
handleMessage();

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

// Recovery function for service worker restarts
async function recoverFromServiceWorkerRestart() {
    console.log('Checking for recovery from service worker restart...');
    
    try {
        // Check for persistent state
        const persistentState = await chrome.storage.local.get([
            'scheduleState',
            'isSchedulePaused',
            'nextWakeUpTime',
            'nextRegularWorkTime',
            'lastScheduleCheck'
        ]);
        
        if (persistentState.lastScheduleCheck) {
            const lastCheck = new Date(persistentState.lastScheduleCheck);
            const timeSinceLastCheck = Date.now() - lastCheck.getTime();
            
            console.log(`Last schedule check was ${Math.round(timeSinceLastCheck/60000)} minutes ago`);
            
            // If it's been more than 5 minutes, we likely had a service worker restart
            if (timeSinceLastCheck > 5 * 60 * 1000) {
                console.log('Detected service worker restart, restoring state...');
                
                // Restore the pause state
                if (persistentState.isSchedulePaused) {
                    isSchedulePaused = persistentState.isSchedulePaused;
                    console.log('Restored schedule pause state:', isSchedulePaused);
                }
                
                // Check if we missed any scheduled wake-ups
                if (persistentState.nextWakeUpTime) {
                    const nextWakeUp = new Date(persistentState.nextWakeUpTime);
                    if (nextWakeUp <= new Date()) {
                        console.log('Missed scheduled wake-up, triggering recovery...');
                        // Schedule system will handle this during initialization
                    }
                }
            }
        }
        
    } catch (error) {
        console.error('Error during service worker recovery:', error);
    }
}
