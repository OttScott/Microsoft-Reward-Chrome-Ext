'use strict';

const MANIFEST_URL = 'https://raw.githubusercontent.com/tmxkn1/Microsoft-Reward-Chrome-Ext/master/src/manifest.json';

document.addEventListener('DOMContentLoaded', () => {
    // Force immediate background refresh on popup open to get fresh data
    chrome.runtime.sendMessage({
        action: 'checkStatus',
    }, () => {
        // Request rewards data from background script after status check
        setTimeout(() => { 
            requestRewardsData();
        }, 500);
    });
    
    // Initial search progress request
    requestSearchProgress();
    
    // Get next scheduled time information
    requestNextScheduledTime();
    
    // Set up auto-refresh for search progress at a SLOWER rate
    setInterval(requestSearchProgress, 5000);
    
    // Set up periodic refresh for rewards data (every 30 seconds)
    setInterval(requestRewardsData, 30000);
    
    // Adjust popup size to fit content
    adjustPopupSize();
    
    // Add reset button event listener if it exists
    const resetButton = document.getElementById('reset-counters');
    if (resetButton) {
        resetButton.addEventListener('click', resetCounters);
    }
    
    // Add connectivity indicator
    updateConnectivityStatus();
    setInterval(updateConnectivityStatus, 30000); // Check every 30 seconds
    
    // Manually trigger background work
    chrome.runtime.sendMessage({
        action: 'checkStatus',
    });

    // Add iframe link interceptor
    setupIframeLinkHandler();
});

function requestRewardsData() {
    chrome.runtime.sendMessage({
        action: 'getRewardsData',
    }, response => {
        if (response && response.success) {
            updateStatsDisplay(response);
        } else {
            console.warn('Failed to get rewards data:', response);
            // Try again after a delay if failed
            setTimeout(requestRewardsData, 3000);
        }
    });
}

function updateStatsDisplay(response) {
    console.log('Rewards data received:', response);
    
    if (!response || !response.success) {
        console.error('Failed to get rewards data:', response);
        showStatsError();
        return;
    }
    
    const data = response.data;
    
    // Check if we have valid data
    if (!data) {
        console.error('Invalid rewards data received');
        showStatsError();
        return;
    }
    
    // Update points earned today
    const todayEarnings = document.getElementById('today-earnings');
    if (todayEarnings) {
        todayEarnings.textContent = data.earnedToday !== undefined ? data.earnedToday : '--';
        // Add a visual indicator that the value was updated
        flashElement(todayEarnings);
    }
    
    // Update points remaining
    const remainingPoints = document.getElementById('remaining-points');
    if (remainingPoints) {
        remainingPoints.textContent = data.remainingPoints !== undefined ? data.remainingPoints : '--';
        flashElement(remainingPoints);
    }
    
    // Update search completion info
    const searchCompleted = document.getElementById('search-completed');
    const searchTotal = document.getElementById('search-total');
    
    if (searchCompleted && searchTotal) {
        const completedSearches = (data.pcSearchProgress || 0) + (data.mbSearchProgress || 0);
        const totalSearches = (data.pcSearchTotal || 0) + (data.mbSearchTotal || 0);
        
        searchCompleted.textContent = completedSearches;
        searchTotal.textContent = totalSearches;
        flashElement(searchCompleted.parentNode);
        
        // Update progress bars
        updateProgressBars(
            data.pcSearchProgress || 0, 
            data.pcSearchTotal || 0, 
            data.mbSearchProgress || 0, 
            data.mbSearchTotal || 0
        );
    }
    
    // Log the successful update
    console.log('Stats display updated with:', {
        earnedToday: data.earnedToday,
        remaining: data.remainingPoints,
        pcProgress: data.pcSearchProgress,
        mbProgress: data.mbSearchProgress
    });
}

// Add helper function to show error state in stats display
function showStatsError() {
    const errorText = '--';
    
    // Show error indicator in stat fields
    const todayEarnings = document.getElementById('today-earnings');
    const remainingPoints = document.getElementById('remaining-points');
    const searchCompleted = document.getElementById('search-completed');
    const searchTotal = document.getElementById('search-total');
    
    if (todayEarnings) todayEarnings.textContent = errorText;
    if (remainingPoints) remainingPoints.textContent = errorText;
    if (searchCompleted) searchCompleted.textContent = errorText;
    if (searchTotal) searchTotal.textContent = errorText;
}

// Add a visual feedback function to show when values update
function flashElement(element) {
    if (!element) return;
    
    // Save original background
    const originalBg = element.style.backgroundColor;
    
    // Add highlight color
    element.style.backgroundColor = '#fffbd1'; // Light yellow highlight
    element.style.transition = 'background-color 1.5s';
    
    // Remove highlight after animation
    setTimeout(() => {
        element.style.backgroundColor = originalBg;
    }, 1500);
}

function updateProgressBars(pcProgress, pcTotal, mbProgress, mbTotal) {
    const pcProgressBar = document.getElementById('pc-progress-bar');
    const mbProgressBar = document.getElementById('mb-progress-bar');
    
    if (pcProgressBar && mbProgressBar) {
        // Calculate total width available (100%)
        const totalSearches = (pcTotal || 0) + (mbTotal || 0);
        
        if (totalSearches > 0) {
            // Calculate what percentage of the bar each search type should take
            const pcRatio = pcTotal / totalSearches;
            const mbRatio = mbTotal / totalSearches;
            
            // Calculate progress within each search type (0-1)
            const pcCompletionRate = pcTotal > 0 ? pcProgress / pcTotal : 0;
            const mbCompletionRate = mbTotal > 0 ? mbProgress / mbTotal : 0;
            
            // Set the width of each progress bar
            pcProgressBar.style.width = `${pcRatio * pcCompletionRate * 100}%`;
            mbProgressBar.style.width = `${mbRatio * mbCompletionRate * 100}%`;
        } else {
            // No searches required
            pcProgressBar.style.width = '0%';
            mbProgressBar.style.width = '0%';
        }
    }
}

function adjustPopupSize() {
    // Determine the total height needed
    const totalHeight = 600; // Adjusted higher to fit everything
    
    // Set the popup height - this is done via width/height properties of document.body
    document.documentElement.style.height = `${totalHeight}px`;
    document.body.style.height = `${totalHeight}px`;
}

function requestSearchProgress() {
    // Add debounce mechanism to prevent excessive calls
    if (requestSearchProgress.inProgress) {
        return;
    }
    
    requestSearchProgress.inProgress = true;
    
    // Wrap in Promise to handle async properly
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({
                action: 'getSearchProgress'
            }, response => {
                requestSearchProgress.inProgress = false;
                
                if (chrome.runtime.lastError) {
                    console.warn('Search progress request error:', chrome.runtime.lastError);
                    resolve(null);
                    return;
                }
                
                if (response && response.success) {
                    updateSearchStatus(response);
                    resolve(response);
                } else {
                    console.warn('Invalid search progress response:', response);
                    resolve(null);
                }
            });
            
            // Ensure we resolve even if no response received
            setTimeout(() => {
                if (requestSearchProgress.inProgress) {
                    requestSearchProgress.inProgress = false;
                    resolve(null);
                }
            }, 1000);
        } catch (error) {
            console.error('Error requesting search progress:', error);
            requestSearchProgress.inProgress = false;
            resolve(null);
        }
    });
}

// Initialize the inProgress flag
requestSearchProgress.inProgress = false;

// Update the updateSearchStatus function to be more resilient
function updateSearchStatus(response) {
    try {
        if (!response) {
            console.warn('No response data for search status update');
            return;
        }

        if (response.inProgress) {
            const timeRemainingSeconds = Math.floor(response.timeRemaining / 1000);
            const minutesRemaining = Math.floor(timeRemainingSeconds / 60);
            const secondsRemaining = timeRemainingSeconds % 60;
            const timeFormatted = `${minutesRemaining}:${secondsRemaining.toString().padStart(2, '0')}`;
            const percentComplete = response.percentComplete || 0;
            
            // Calculate overall search completion percentage
            const overallProgressPercent = Math.floor((response.current / response.total) * 100);
            
            // Create or update status element
            let statusElement = document.getElementById('search-status');
            if (!statusElement) {
                statusElement = document.createElement('div');
                statusElement.id = 'search-status';
                statusElement.className = 'search-status-info';
                const header = document.querySelector('header');
                if (header) {
                    header.appendChild(statusElement);
                } else {
                    document.body.insertBefore(statusElement, document.body.firstChild);
                }
            }
            
            // Calculate countdown progress - inverse of percentComplete
            const countdownProgress = 100 - percentComplete;
            
            statusElement.innerHTML = `
                <div class="status-banner ${response.type === 'PC' ? 'pc-search' : 'mobile-search'}">
                    <div class="search-header">
                        <span>${response.type} search: ${response.current}/${response.total}</span>
                        <span class="time-remaining">Next: ${timeFormatted}</span>
                    </div>
                    
                    <div class="progress-bars">
                        <div class="progress-container search-progress-container">
                            <div class="progress-label">Overall Progress</div>
                            <div class="progress-bar" style="width: ${overallProgressPercent}%"></div>
                        </div>
                        
                        <div class="progress-container countdown-container">
                            <div class="progress-label">Next Search</div>
                            <div class="countdown-progress-bar" style="width: ${countdownProgress}%"></div>
                        </div>
                    </div>
                    
                    ${response.searchTerm ? `
                        <div class="search-term-container">
                            Current: "${response.searchTerm}"
                        </div>
                    ` : ''}
                    
                    ${response.nextSearchTerm ? `
                        <div class="next-search-container">
                            <div class="next-search-term">Next: "${response.nextSearchTerm}"</div>
                            <button id="skip-search-button" class="skip-button">Skip</button>
                        </div>
                    ` : ''}
                </div>`;
            
            // Ensure element is visible
            statusElement.style.display = 'block';
            
            // Add click handler for the skip button
            const skipButton = document.getElementById('skip-search-button');
            if (skipButton) {
                // Remove any existing listeners first
                const newSkipButton = skipButton.cloneNode(true);
                skipButton.parentNode.replaceChild(newSkipButton, skipButton);
                newSkipButton.addEventListener('click', skipCurrentSearch);
            }
        } else {
            // Show next scheduled run instead
            let statusElement = document.getElementById('search-status');
            if (!statusElement) {
                statusElement = document.createElement('div');
                statusElement.id = 'search-status';
                statusElement.className = 'search-status-info';
                const header = document.querySelector('header');
                if (header) {
                    header.appendChild(statusElement);
                } else {
                    document.body.insertBefore(statusElement, document.body.firstChild);
                }
            }
            
            // Request next scheduled time info
            requestNextScheduledTime();
            
            statusElement.innerHTML = `<div id="next-schedule" class="schedule-info"></div>`;
            statusElement.style.display = 'block';
        }
    } catch (error) {
        console.error('Error updating search status:', error);
    }
}

// Add function to handle skip button clicks
function skipCurrentSearch() {
    console.log('Skip button clicked');
    
    // Disable the button while processing
    const skipButton = document.getElementById('skip-search-button');
    if (skipButton) {
        skipButton.disabled = true;
        skipButton.textContent = 'Skipping...';
    }
    
    // Send skip request to background script
    chrome.runtime.sendMessage({
        action: 'skipCurrentSearch'
    }, response => {
        console.log('Skip response:', response);
        
        // Re-enable the button
        if (skipButton) {
            skipButton.disabled = false;
            skipButton.textContent = 'Skip';
        }
        
        // Request fresh search progress after a short delay
        setTimeout(requestSearchProgress, 500);
    });
}

function checkUpdate() {
    fetch(MANIFEST_URL, {method: 'GET'}).then((response) => {
        if (response.ok) {
            return response.json();
        }
        throw new Error('Fetch failed.');
    }).then((manifest) => {
        const currentVersion = chrome.runtime.getManifest().version;
        const latestVersion = manifest.version;
        if (currentVersion !== latestVersion) {
            document.getElementById('update-available').style.display = 'block';
        } else {
            document.getElementById('update-available').style.display = 'none';
        }
    });
}

function resetCounters() {
    chrome.runtime.sendMessage({
        action: 'resetCounters'
    }, response => {
        if (response && response.success) {
            console.log('Counters reset successfully');
            // Force a refresh of the popup
            setTimeout(() => {
                window.location.reload();
            }, 500);
        }
    });
}

function updateConnectivityStatus() {
    chrome.runtime.sendMessage({
        action: 'checkConnectivity'
    }, response => {
        const indicator = document.getElementById('connection-status');
        if (!indicator) return;
        
        // Check if we have a valid response
        if (response && response.success) {
            if (response.isConnected) {
                indicator.className = 'connection-status connected';
                indicator.title = 'Internet connection is active';
            } else {
                indicator.className = 'connection-status disconnected';
                indicator.title = 'Internet connection is down';
            }
        } else {
            // If we can't get a valid response, trust the browser's navigator.onLine
            if (navigator.onLine) {
                indicator.className = 'connection-status connected';
                indicator.title = 'Internet connection is active';
            } else {
                indicator.className = 'connection-status disconnected';
                indicator.title = 'Internet connection is down';
            }
        }
    });
}

checkUpdate();

// Listen for search progress updates from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.action) return false;

    switch (message.action) {
        case 'searchCompleted':
            // Request fresh search progress
            requestSearchProgress().then(() => {
                // Also immediately update stats when a search is completed
                requestRewardsData();
            });
            break;
            
        case 'searchSkipped':
            // Special handling for search skipped to update UI immediately
            console.log('Search skip detected, updating UI with new term:', message.content);
            
            // Force immediate update of search progress to show new term
            requestSearchProgress().then(() => {
                // Additional UI updates if needed
                if (message.content && message.content.nextTerm) {
                    // Update next term display immediately if available
                    const nextTermElement = document.querySelector('.next-search-term');
                    if (nextTermElement) {
                        nextTermElement.textContent = `Next: "${message.content.nextTerm}"`;
                    }
                }
            });
            break;
            
        default:
            return false;
    }
    
    // We handled the message but don't need to send a response
    return false;
});

// Simplify the iframe handling - don't add duplicate event listeners
function setupIframeLinkHandler() {
    console.log('Setting up iframe handlers');
    
    // Add click listener for rewards button
    const rewardsButton = document.getElementById('rewards-open-button');
    if (rewardsButton) {
        rewardsButton.addEventListener('click', (e) => {
            e.preventDefault();
            
            // Use the helper if available, otherwise open directly
            if (window.rewardsHelper && typeof window.rewardsHelper.openRewards === 'function') {
                window.rewardsHelper.openRewards();
            } else {
                chrome.tabs.create({ url: 'https://rewards.bing.com/' });
            }
        });
    }
    
    // The rest is handled by iframe-helper.js
}

// Use the helper's function instead of creating our own
window.openInNewTab = function(url) {
    console.log('Opening URL in new tab via helper:', url);
    
    // Use the helper if it's available
    if (window.rewardsHelper && typeof window.rewardsHelper.openUrlInNewTab === 'function') {
        window.rewardsHelper.openUrlInNewTab(url);
    } else {
        // Fallback if the helper isn't loaded yet
        chrome.tabs.create({ url: url });
    }
};

// Add function to request next scheduled time
function requestNextScheduledTime() {
    chrome.runtime.sendMessage({
        action: 'getNextScheduledTime'
    }, response => {
        if (response && response.success) {
            updateScheduleDisplay(response);
        }
    });
}

// Add function to update schedule display
function updateScheduleDisplay(response) {
    const scheduleElement = document.getElementById('next-schedule');
    if (!scheduleElement) return;
    
    if (response.nextScheduledTime) {
        // Calculate time until next run
        const nextRun = new Date(response.nextScheduledTime);
        const now = new Date();
        const timeUntil = nextRun - now;
        
        // Only display if it's in the future
        if (timeUntil > 0) {
            const minutesUntil = Math.floor(timeUntil / 60000);
            const secondsUntil = Math.floor((timeUntil % 60000) / 1000);
            
            scheduleElement.innerHTML = `Next run: ${nextRun.toLocaleTimeString()} (in ${minutesUntil}m ${secondsUntil}s)`;
            scheduleElement.style.display = 'block';
            
            // Add manual search start button
            scheduleElement.innerHTML += '<div class="manual-start-container"><button id="start-searches-now" class="action-button">Start Searches Now</button></div>';
            
            // Add event listener to the button
            const startButton = document.getElementById('start-searches-now');
            if (startButton) {
                startButton.addEventListener('click', () => {
                    chrome.runtime.sendMessage({
                        action: 'startSearches'
                    }, response => {
                        if (response && response.success) {
                            startButton.textContent = 'Starting...';
                            startButton.disabled = true;
                            // Refresh search status after a delay
                            setTimeout(requestSearchProgress, 2000);
                        }
                    });
                });
            }
        } else {
            scheduleElement.innerHTML = 'Searches should be starting soon...';
        }
    } else {
        scheduleElement.innerHTML = 'No scheduled searches found. <button id="start-searches-now" class="action-button">Start Searches Now</button>';
        
        // Add event listener to the button
        const startButton = document.getElementById('start-searches-now');
        if (startButton) {
            startButton.addEventListener('click', () => {
                chrome.runtime.sendMessage({
                    action: 'startSearches'
                }, response => {
                    if (response && response.success) {
                        startButton.textContent = 'Starting...';
                        startButton.disabled = true;
                        // Refresh search status after a delay
                        setTimeout(requestSearchProgress, 2000);
                    }
                });
            });
        }
    }
}
