// Debug script to check scheduling system state
// Run this in the Chrome extension's background page console

async function debugSchedulingState() {
    console.log('=== SCHEDULING SYSTEM DEBUG ===');
    
    // Check current variables
    console.log('Global state:', {
        isSchedulePaused,
        scheduleWakeUpTimer: scheduleWakeUpTimer !== null,
        scheduledWorkTimer: scheduledWorkTimer !== null,
        workIntervalId: workIntervalId !== null
    });
    
    // Check storage state
    const storageData = await chrome.storage.local.get([
        'scheduleState',
        'isSchedulePaused', 
        'nextWakeUpTime',
        'nextRegularWorkTime',
        'lastScheduleCheck',
        'pausedAt'
    ]);
    console.log('Storage state:', storageData);
    
    // Check sync settings
    const syncSettings = await chrome.storage.sync.get([
        'enableSchedule',
        'startTime', 
        'endTime',
        'baseSearchInterval',
        'intervalVariation'
    ]);
    console.log('Sync settings:', syncSettings);
    
    // Check searchQuest state
    if (typeof searchQuest !== 'undefined') {
        console.log('SearchQuest state:', {
            jobStatus: searchQuest.jobStatus,
            pausedBySchedule: searchQuest._pausedBySchedule
        });
    }
    
    // Check current schedule
    try {
        const withinSchedule = await checkCurrentScheduleState();
        console.log('Current schedule check result:', withinSchedule);
    } catch (error) {
        console.error('Error checking schedule:', error);
    }
    
    console.log('=== END DEBUG ===');
}

// Also add a function to manually trigger scheduling
async function manuallyInitializeScheduling() {
    console.log('Manually initializing scheduling system...');
    try {
        await initializeScheduleSystem();
        console.log('Schedule system initialized');
        
        // Also schedule next work
        await scheduleNextWork();
        console.log('Next work scheduled');
        
        // Debug the result
        await debugSchedulingState();
    } catch (error) {
        console.error('Error during manual initialization:', error);
    }
}

// Run debug immediately
debugSchedulingState();
