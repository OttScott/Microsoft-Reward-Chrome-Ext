'use strict';

// Constants
const REWARDS_DIRECT_URL = 'https://rewards.bing.com';
const BING_DOMAIN = 'bing.com';
const MICROSOFT_DOMAIN = 'microsoft.com';

// Track if we've already opened a tab to prevent duplicates
let tabOpenedRecently = false;

document.addEventListener('DOMContentLoaded', () => {
    // Show the direct link immediately
    showDirectLink();
    
    // Set up message listener for cross-origin communication 
    setupMessageListener();
    
    // Add click handler with duplicate prevention
    setupLinkHandler();
});

function showDirectLink() {
    const helperLink = document.getElementById('rewards-direct-link');
    if (helperLink) {
        console.log('Activating direct rewards link');
        helperLink.style.display = 'block';
    }
}

function setupMessageListener() {
    console.log('Setting up iframe message listener');
    window.addEventListener('message', handleMessage);
}

function handleMessage(event) {
    // Only handle messages from trusted origins
    if (!isTrustedOrigin(event.origin)) {
        console.warn('Ignored message from untrusted origin:', event.origin);
        return;
    }

    if (event.data && event.data.action === 'openLink' && event.data.url) {
        console.log('Received link request from iframe:', event.data.url);
        openUrlInNewTab(event.data.url);
    }
}

function setupLinkHandler() {
    // Get all elements that should open links
    const rewardsLink = document.querySelector('#rewards-direct-link a');
    
    if (rewardsLink) {
        rewardsLink.addEventListener('click', (e) => {
            e.preventDefault();
            
            // Prevent double-opening
            if (tabOpenedRecently) {
                console.log('Tab was recently opened, ignoring click');
                return;
            }
            
            // Open the rewards page
            openRewards();
        });
    }
}

function isTrustedOrigin(origin) {
    return origin && (
        origin.includes(BING_DOMAIN) || 
        origin.includes(MICROSOFT_DOMAIN)
    );
}

function openRewards() {
    console.log('Opening Microsoft Rewards in new tab');
    if (tabOpenedRecently) {
        console.log('Prevented duplicate tab open');
        return;
    }
    
    // Set flag to prevent duplicates
    tabOpenedRecently = true;
    
    // Open the tab
    chrome.tabs.create({ url: REWARDS_DIRECT_URL });
    
    // Reset flag after a short delay
    setTimeout(() => {
        tabOpenedRecently = false;
    }, 1000);
}

function openUrlInNewTab(url) {
    if (!url) return;
    
    // Prevent duplicate tabs
    if (tabOpenedRecently) {
        console.log('Tab was recently opened, ignoring url open request');
        return;
    }
    
    try {
        // Validate URL for security
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
            // Set flag to prevent duplicates
            tabOpenedRecently = true;
            
            // Open URL in new tab
            chrome.tabs.create({ url: url });
            
            // Reset flag after a short delay
            setTimeout(() => {
                tabOpenedRecently = false;
            }, 1000);
        } else {
            console.warn('Blocked opening non-HTTP URL:', url);
        }
    } catch (e) {
        console.error('Invalid URL:', url, e);
    }
}

// Export functions for use in popup.js without causing duplicates
window.rewardsHelper = {
    openRewards: openRewards,
    openUrlInNewTab: openUrlInNewTab
};
