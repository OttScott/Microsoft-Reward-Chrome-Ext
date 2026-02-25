'use strict';

// Get element methods
function getElementCountdownAlgorithm() {
    return document.getElementById('use-old-countdown-algorithm');
}

function getElementPcUaOverrideEnable() {
    return document.getElementById('pc-ua-override-enable');
}

function getElementMbUaOverrideEnable() {
    return document.getElementById('mb-ua-override-enable');
}

function getElementPcUaOverrideValue() {
    return document.getElementById('pc-ua-override-value');
}

function getElementMbUaOverrideValue() {
    return document.getElementById('mb-ua-override-value');
}

// Chrome storage methods
function saveOptions() {
    const options = {
        compatibilityMode: getElementCountdownAlgorithm().checked,
        pcUaOverrideEnable: getElementPcUaOverrideEnable().checked,
        mbUaOverrideEnable: getElementMbUaOverrideEnable().checked,
        pcUaOverrideValue: getElementPcUaOverrideValue().value,
        mbUaOverrideValue: getElementMbUaOverrideValue().value,
        startTime: document.getElementById('startTime').value,
        endTime: document.getElementById('endTime').value,
        enableSchedule: document.getElementById('enableSchedule').checked,
        baseSearchCount: parseInt(document.getElementById('baseSearchCount').value) || 30,
        searchVariation: parseInt(document.getElementById('searchVariation').value) || 5,
        disableMobile: document.getElementById('disableMobile').checked,
        baseSearchInterval: document.getElementById('baseSearchInterval').value,
        intervalVariation: document.getElementById('intervalVariation').value,
        smartSwitching: document.getElementById('smartSwitching').checked,
        interleaveSearches: document.getElementById('interleaveSearches').checked,
        enableExploreTasks: document.getElementById('enableExploreTasks').checked,
        enableDailyTasks: document.getElementById('enableDailyTasks').checked,
        randomizeAnswers:  document.getElementById('randomizeAnswers').checked,
        dailyTaskDelay:    parseInt(document.getElementById('dailyTaskDelay').value) || 0
    };

    chrome.storage.sync.set(options, () => {
        chrome.runtime.sendMessage({
            action: 'updateSearchSettings',
            content: {
                baseSearchCount: options.baseSearchCount,
                searchVariation: options.searchVariation,
                smartSwitching: options.smartSwitching,
                interleaveSearches: options.interleaveSearches
            }
        }, () => {
            const status = document.getElementById('status');
            status.textContent = 'Options saved.';
            setTimeout(() => status.textContent = '', 2000);
        });
    });
}

function restoreOptions() {
    chrome.storage.sync.get({
        compatibilityMode: false,
        pcUaOverrideEnable: false,
        mbUaOverrideEnable: false,
        pcUaOverrideValue: '',
        mbUaOverrideValue: '',
        startTime: '09:00',
        endTime: '17:00',
        enableSchedule: false,
        baseSearchCount: 30,    // Default values
        searchVariation: 5,
        disableMobile: false,
        baseSearchInterval: 15,  // 15 minutes default
        intervalVariation: 300,   // 5 minutes (300 seconds) variation
        smartSwitching: true,    // Default to smart switching enabled
        interleaveSearches: false, // Default to traditional sequential searches
        enableExploreTasks: true,  // Default to explore tasks enabled
        enableDailyTasks: false,
        randomizeAnswers: true,
        dailyTaskDelay: 5
    }, function (options) {
        getElementCountdownAlgorithm().checked = options.compatibilityMode;
        getElementPcUaOverrideEnable().checked = options.pcUaOverrideEnable;
        getElementMbUaOverrideEnable().checked = options.mbUaOverrideEnable;
        getElementPcUaOverrideValue().value = options.pcUaOverrideValue;
        getElementMbUaOverrideValue().value = options.mbUaOverrideValue;
        document.getElementById('startTime').value = options.startTime;
        document.getElementById('endTime').value = options.endTime;
        document.getElementById('enableSchedule').checked = options.enableSchedule;
        document.getElementById('baseSearchCount').value = options.baseSearchCount;
        document.getElementById('searchVariation').value = options.searchVariation;
        document.getElementById('disableMobile').checked = options.disableMobile;
        document.getElementById('baseSearchInterval').value = options.baseSearchInterval;
        document.getElementById('intervalVariation').value = options.intervalVariation;
        document.getElementById('smartSwitching').checked = options.smartSwitching;
        document.getElementById('interleaveSearches').checked = options.interleaveSearches;
        document.getElementById('enableExploreTasks').checked = options.enableExploreTasks;
        document.getElementById('enableDailyTasks').checked = options.enableDailyTasks;
        document.getElementById('randomizeAnswers').checked  = options.randomizeAnswers;
        document.getElementById('dailyTaskDelay').value      = options.dailyTaskDelay;
    });
}

function sendOptions(options) {
    chrome.runtime.sendMessage({
        action: 'updateOptions',
        content: options,
    });
}

// Event listeners
document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('save').addEventListener('click', saveOptions);

document.getElementById('copy-debug-info').addEventListener('click', () => {
    chrome.runtime.sendMessage({
        action: 'copyDebugInfo',
    });
});

getElementCountdownAlgorithm().addEventListener('click', saveOptions);
getElementPcUaOverrideEnable().addEventListener('click', saveOptions);
getElementMbUaOverrideEnable().addEventListener('click', saveOptions);
getElementPcUaOverrideValue().addEventListener('change', saveOptions);
getElementMbUaOverrideValue().addEventListener('change', saveOptions);

// Add mutual exclusivity logic for search strategies
document.getElementById('smartSwitching').addEventListener('change', function() {
    if (this.checked) {
        document.getElementById('interleaveSearches').checked = false;
    }
    saveOptions();
});

document.getElementById('interleaveSearches').addEventListener('change', function() {
    if (this.checked) {
        document.getElementById('smartSwitching').checked = false;
    }
    saveOptions();
});

document.getElementById('version-number').innerText = 'V' + chrome.runtime.getManifest().version;
