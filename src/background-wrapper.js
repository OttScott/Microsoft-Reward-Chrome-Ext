console.log('Loading background wrapper v1...');

// Define constants globally before loading any scripts
self.STATUS_NONE = 0;
self.STATUS_BUSY = 1;
self.STATUS_DONE = 20;
self.STATUS_WARNING = 30;
self.STATUS_ERROR = 3;

self.SEARCH_TYPE_PC_SEARCH = 0;
self.SEARCH_TYPE_MB_SEARCH = 1;

// Set up error handlers
self.onerror = (msg, source, line, col, error) => {
    console.error('Global error:', { msg, source, line, col, error: error?.toString(), stack: error?.stack });
};

// Load script with error checking
function loadScript(name) {
    try {
        console.log(`Loading ${name}...`);
        importScripts(name);
        console.log(`Loaded ${name}`);
        return true;
    } catch (error) {
        console.error(`Failed to load ${name}:`, error);
        return false;
    }
}

// Load scripts in dependency order
const scripts = [
    'badge.js',
    'exception.js',
    'utility.js',
    'googleTrend.js',
    'status/DailyRewardStatus.js',
    'quest/searchQuest.js',
    'quest/exploreQuest.js',
    'quest/dailyTasksQuest.js',
    'background.js'
];

let success = true;
for (const script of scripts) {
    if (!loadScript(script)) {
        success = false;
        break;
    }
}

if (success) {
    console.log('All scripts loaded successfully');
} else {
    console.error('Script loading failed');
}
