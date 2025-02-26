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
        disableMobile: document.getElementById('disableMobile').checked
    };

    chrome.storage.sync.set(options, () => {
        chrome.runtime.sendMessage({
            action: 'updateSearchSettings',
            content: {
                baseSearchCount: options.baseSearchCount,
                searchVariation: options.searchVariation
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
        disableMobile: false
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

document.getElementById('version-number').innerText = 'V' + chrome.runtime.getManifest().version;
