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

// Initialize core objects
const googleTrend = new GoogleTrend();
const userDailyStatus = new DailyRewardStatus();
const searchQuest = new SearchQuest(googleTrend);

console.log('Background script loading - ' + new Date().toISOString());

function onExtensionLoad() {
    console.log('Microsoft Rewards Bot: Extension starting...');
    try {
        setBadge(new GreyBadge());
        console.log('Badge set to grey');
        loadSavedSettings();
        getDeveloperSettings();
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

function initialize() {
    console.log('Microsoft Rewards Bot: Initialization started');
    doBackgroundWork();

    // Clear any existing interval
    if (workIntervalId) {
        clearInterval(workIntervalId);
    }

    console.log('Setting up background work interval...');
    workIntervalId = setInterval(
        function () {
            console.log('Running scheduled background work...');
            doBackgroundWork();
        },
        WORKER_ACTIVATION_INTERVAL,
    );
}

async function isWithinSchedule() {
    const settings = await chrome.storage.sync.get({
        startTime: '09:00',
        endTime: '17:00',
        enableSchedule: false
    });

    if (!settings.enableSchedule) {
        return true;
    }

    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();
    
    const [startHour, startMinute] = settings.startTime.split(':').map(Number);
    const [endHour, endMinute] = settings.endTime.split(':').map(Number);
    
    const startMinutes = startHour * 60 + startMinute;
    const endMinutes = endHour * 60 + endMinute;

    const isWithin = currentTime >= startMinutes && currentTime <= endMinutes;
    
    // If we're outside schedule, cleanup timers and show inactive badge
    if (!isWithin && workIntervalId) {
        console.log('Outside schedule, cleaning up timers');
        clearInterval(workIntervalId);
        workIntervalId = null;
        setBadge(new ScheduleInactiveBadge());
    }

    return isWithin;
}

async function doBackgroundWork() {
    console.log('Background work starting...');
    
    if (!await isWithinSchedule()) {
        console.log('Outside scheduled hours, pausing work');
        return;
    }
    
    if (searchQuest.jobStatus == STATUS_BUSY || userDailyStatus.jobStatus == STATUS_BUSY) {
        console.log('Work already in progress, skipping...');
        return;
    }

    await waitTillOnline();

    setBadge(new BusyBadge());

    checkNewDay();
    await checkDailyRewardStatus();

    if (isCurrentBadge('busy')) {
        setBadge(new DoneBadge());
    }
}

async function waitTillOnline() {
    while (!navigator.onLine) {
        await setTimeoutAsync(WAIT_FOR_ONLINE_TIMEOUT);
    }
}

async function setTimeoutAsync(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkDailyRewardStatus() {
    // update status
    let result;
    try {
        result = await userDailyStatus.update();
    } catch (ex) {
        handleException(ex);
    }
    if (!result || !userDailyStatus.summary.isValid) {
        setBadge(new ErrorBadge());
        return;
    }

    await doSearchQuests();

    checkQuizAndDaily();
}

async function doSearchQuests() {
    if (userDailyStatus.summary.isCompleted) {
        return;
    }

    if (!userDailyStatus.pcSearchStatus.isCompleted || !userDailyStatus.mbSearchStatus.isCompleted) {
        try {
            await searchQuest.doWork(userDailyStatus);
        } catch (ex) {
            handleException(ex);
        }
    }
}

const WORKER_ACTIVATION_INTERVAL = 7200000; // Interval at which automatic background works are carried out, in ms.
const WAIT_FOR_ONLINE_TIMEOUT = 60000;

// Basic runtime setup
chrome.runtime.onInstalled.addListener((details) => {
    console.log('Extension installed or updated:', details.reason);
    onExtensionLoad();
});

// Message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Message received:', message);
    switch (message.action) {
        case 'checkStatus':
            doBackgroundWork();
            sendResponse({success: true});
            break;
        case 'updateOptions':
            _compatibilityMode = message.content.compatibilityMode;
            _pcUaOverrideEnable = message.content.pcUaOverrideEnable;
            _mbUaOverrideEnable = message.content.mbUaOverrideEnable;
            _pcUaOverrideValue = message.content.pcUaOverrideValue;
            _mbUaOverrideValue = message.content.mbUaOverrideValue;
            sendResponse({success: true});
            break;
        case 'copyDebugInfo':
            getDebugInfo();
            sendResponse({success: true});
            break;
        case 'updateSchedule':
            chrome.storage.sync.set({
                startTime: message.content.startTime,
                endTime: message.content.endTime,
                enableSchedule: message.content.enableSchedule
            }, () => {
                console.log('Schedule updated:', message.content);
                // Re-initialize to apply new schedule
                initialize();
                sendResponse({success: true});
            });
            break;
        case 'updateSearchSettings':
            chrome.storage.sync.set({
                baseSearchCount: message.content.baseSearchCount,
                searchVariation: message.content.searchVariation
            }, async () => {
                console.log('Search settings updated:', message.content);
                // Reload search settings and recalculate counts
                await searchQuest._loadSearchSettings();
                // Trigger a status update to refresh display
                await userDailyStatus.update();
                sendResponse({success: true});
            });
            break;
    }
    return true; // Required to use sendResponse asynchronously
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

// Handle extension unload
chrome.runtime.onSuspend.addListener(() => {
    console.log('Extension suspending, cleaning up...');
    if (workIntervalId) {
        clearInterval(workIntervalId);
        workIntervalId = null;
    }
});

console.log('Background script initialization complete');
