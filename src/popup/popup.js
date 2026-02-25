'use strict';

// Track last countdown progress to prevent jumping
let lastCountdownProgress = null;
// Track last search key to detect when a new search starts
let lastSearchTrackingKey = null;

document.addEventListener('DOMContentLoaded', () => {
    // Check for missed morning start when popup opens
    chrome.runtime.sendMessage({
        action: 'checkMissedMorningStart'
    });
    
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
    
    // Set up client-side countdown timer for active searches
    setInterval(updateClientSideCountdown, 1000);
    
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

    // Add Explore Tasks button handler
    const exploreBtn = document.getElementById('show-explore-tasks');
    if (exploreBtn) {
        exploreBtn.addEventListener('click', toggleExploreTasksPanel);
    }

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
        // Return a resolved Promise instead of undefined
        return Promise.resolve(null);
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
    updateSearchStatusImmediate(response);
}

// Add immediate update function for real-time progress updates
function updateSearchStatusImmediate(response) {
    try {
        if (!response) {
            console.warn('No response data for search status update');
            return;
        }

        if (response.inProgress) {
            // Reset countdown progress tracking when starting a new search or if it's a different search
            if (!lastSearchStatus || 
                lastSearchStatus.current !== response.current ||
                lastSearchStatus.type !== response.type) {
                lastCountdownProgress = null;
                console.log('Reset countdown progress tracking for new search');
            }
            
            // Store the search status for client-side countdown
            lastSearchStatus = {
                ...response,
                lastUpdateTime: new Date(),
                searchInterval: response.searchInterval || response.totalIntervalMs || 900000 // 15 min default
            };
            
            const timeRemainingSeconds = Math.floor(response.timeRemaining / 1000);
            const minutesRemaining = Math.floor(timeRemainingSeconds / 60);
            const secondsRemaining = timeRemainingSeconds % 60;
            const timeFormatted = `${minutesRemaining}:${secondsRemaining.toString().padStart(2, '0')}`;
            const percentComplete = Math.max(0, Math.min(100, response.percentComplete || 0));
            
            // Add debugging for progress calculation issues
            if (response.percentComplete > 100 || response.percentComplete < 0 || isNaN(response.percentComplete)) {
                console.warn('Invalid percentComplete from server:', response.percentComplete, 'using clamped value:', percentComplete);
            }
            
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
            
            // Calculate countdown progress - inverse of percentComplete with enhanced validation
            let countdownProgress = 100; // Default to full countdown if no valid data
            
            if (response.percentComplete !== undefined && response.percentComplete !== null) {
                // percentComplete from server represents elapsed time (0-100%)
                // countdownProgress should show remaining time, so invert it
                const serverProgress = Math.max(0, Math.min(100, response.percentComplete || 0));
                countdownProgress = 100 - serverProgress;
            } else {
                console.warn('No percentComplete received from server, using fallback calculation');
                // Fallback calculation using time remaining
                if (response.timeRemaining && response.searchInterval) {
                    const remainingRatio = Math.max(0, Math.min(1, response.timeRemaining / response.searchInterval));
                    countdownProgress = Math.floor(remainingRatio * 100);
                }
            }
            
            // Validate the calculated progress
            if (isNaN(countdownProgress) || !isFinite(countdownProgress)) {
                console.warn('Invalid countdown progress calculated, using fallback:', countdownProgress);
                countdownProgress = lastCountdownProgress || 100;
            }
            
            // Reset countdown tracking when starting a new search
            const currentSearchKey = `${response.type}-${response.current}`;
            if (lastSearchTrackingKey !== currentSearchKey) {
                lastCountdownProgress = null; // Reset for new search
                lastSearchTrackingKey = currentSearchKey;
                console.log('New search detected in popup, reset countdown tracking:', currentSearchKey);
            }
            
            // Prevent progress bar from jumping backwards within the same search
            if (lastCountdownProgress !== null && countdownProgress < lastCountdownProgress) {
                // Allow some tolerance for calculation differences (3% margin)
                if (lastCountdownProgress - countdownProgress > 3) {
                    console.log('Countdown progress jumped backwards, smoothing:', 
                        `calculated: ${countdownProgress}%, last: ${lastCountdownProgress}%, using: ${lastCountdownProgress}%`,
                        'serverPercent:', response.percentComplete, 'timeRemaining:', Math.floor((response.timeRemaining || 0)/1000) + 's'
                    );
                    countdownProgress = lastCountdownProgress;
                } else {
                    // Small jump is acceptable, might be due to rounding
                    lastCountdownProgress = countdownProgress;
                }
            } else {
                // Progress moved forward or stayed same - update tracking
                lastCountdownProgress = countdownProgress;
            }
            
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
                            <div class="search-buttons">
                                <button id="skip-search-button" class="skip-button">Skip</button>
                                <button id="force-search-button" class="force-button">Next</button>
                                <button id="stop-search-button" class="stop-button">Stop</button>
                            </div>
                        </div>
                    ` : ''}
                </div>`;
            
            // Ensure element is visible
            statusElement.style.display = 'block';
            
            // Add click handlers for the search control buttons
            const skipButton = document.getElementById('skip-search-button');
            if (skipButton) {
                // Remove any existing listeners first
                const newSkipButton = skipButton.cloneNode(true);
                skipButton.parentNode.replaceChild(newSkipButton, skipButton);
                newSkipButton.addEventListener('click', skipCurrentSearch);
            }
            
            const forceButton = document.getElementById('force-search-button');
            if (forceButton) {
                // Remove any existing listeners first
                const newForceButton = forceButton.cloneNode(true);
                forceButton.parentNode.replaceChild(newForceButton, forceButton);
                newForceButton.addEventListener('click', forceNextSearch);
            }
            
            const stopButton = document.getElementById('stop-search-button');
            if (stopButton) {
                // Remove any existing listeners first
                const newStopButton = stopButton.cloneNode(true);
                stopButton.parentNode.replaceChild(newStopButton, stopButton);
                newStopButton.addEventListener('click', stopSearches);
            }
        } else {
            // Clear the last search status when not in progress
            lastSearchStatus = null;
            // Reset countdown progress tracking
            lastCountdownProgress = null;
            
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

// Add function to handle force search button clicks
function forceNextSearch() {
    console.log('Force search button clicked');
    
    // Disable the button while processing
    const forceButton = document.getElementById('force-search-button');
    if (forceButton) {
        forceButton.disabled = true;
        forceButton.textContent = 'Starting...';
    }
    
    // Send force request to background script
    chrome.runtime.sendMessage({
        action: 'forceNextSearch'
    }, response => {
        console.log('Force response:', response);
        
        // Re-enable the button
        if (forceButton) {
            forceButton.disabled = false;
            forceButton.textContent = 'Next';
        }
        
        // Request fresh search progress after a short delay
        setTimeout(requestSearchProgress, 500);
    });
}

function stopSearches() {
    console.log('Stop searches button clicked');
    
    // Disable the button while processing
    const stopButton = document.getElementById('stop-search-button');
    if (stopButton) {
        stopButton.disabled = true;
        stopButton.textContent = 'Stopping...';
    }
    
    // Send stop request to background script
    chrome.runtime.sendMessage({
        action: 'stopSearches'
    }, response => {
        console.log('Stop response:', response);
        
        // Update the button based on response
        if (stopButton) {
            stopButton.disabled = false;
            if (response && response.success) {
                stopButton.textContent = 'Stopped';
                // Change back to "Stop" after a moment
                setTimeout(() => {
                    stopButton.textContent = 'Stop';
                }, 2000);
                
                // Force a refresh of the popup to show stopped state
                setTimeout(() => {
                    window.location.reload();
                }, 1000);
            } else {
                stopButton.textContent = 'Stop';
            }
        }
        
        // Request fresh search progress after a short delay
        setTimeout(requestSearchProgress, 500);
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
            
        case 'searchStarting':
            // Handle immediate search starting notification
            console.log('Search starting notification received:', message.content);
            // Immediately update the UI to show the new search
            if (message.content) {
                updateSearchStatusImmediate({
                    inProgress: true,
                    type: message.content.type,
                    current: message.content.current - 1, // Adjust for display
                    total: message.content.total,
                    searchTerm: message.content.searchWord,
                    timeRemaining: 5000, // Show a brief "searching..." state
                    percentComplete: 0
                });
            }
            break;
            
        case 'searchProgressUpdate':
            // Handle real-time progress updates during waits
            console.log('Live progress update received:', message.content);
            if (message.content && message.content.inProgress) {
                updateSearchStatusImmediate(message.content);
            }
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

// Global variable to track search status for client-side countdown
let lastSearchStatus = null;

// Add client-side countdown timer for smoother UI updates
function updateClientSideCountdown() {
    if (!lastSearchStatus || !lastSearchStatus.inProgress) {
        return;
    }
    
    // Calculate time remaining based on when we last got the update
    const now = new Date();
    const timeSinceUpdate = now - (lastSearchStatus.lastUpdateTime || now);
    const adjustedTimeRemaining = Math.max(0, lastSearchStatus.timeRemaining - timeSinceUpdate);
    
    // Update the display if we have a time remaining element
    const timeElement = document.querySelector('.time-remaining');
    if (timeElement && adjustedTimeRemaining > 0) {
        const timeRemainingSeconds = Math.floor(adjustedTimeRemaining / 1000);
        const minutesRemaining = Math.floor(timeRemainingSeconds / 60);
        const secondsRemaining = timeRemainingSeconds % 60;
        const timeFormatted = `${minutesRemaining}:${secondsRemaining.toString().padStart(2, '0')}`;
        timeElement.textContent = `Next: ${timeFormatted}`;
    }
    
    // Update the countdown progress bar with enhanced smoothing
    const countdownBar = document.querySelector('.countdown-progress-bar');
    if (countdownBar && lastSearchStatus.searchInterval) {
        // Check if this is a new search by comparing with tracking key
        const currentClientSearchKey = `${lastSearchStatus.type}-${lastSearchStatus.current}`;
        if (lastSearchTrackingKey !== currentClientSearchKey) {
            // Reset countdown progress for new search
            lastCountdownProgress = null;
            lastSearchTrackingKey = currentClientSearchKey;
            console.log('Client-side new search detected, reset progress:', currentClientSearchKey);
        }
        
        const totalElapsed = lastSearchStatus.searchInterval - adjustedTimeRemaining;
        const percentComplete = Math.max(0, Math.min(100, Math.floor((totalElapsed / lastSearchStatus.searchInterval) * 100)));
        let countdownProgress = Math.max(0, Math.min(100, 100 - percentComplete));
        
        // Validate the calculated progress
        if (isNaN(countdownProgress) || !isFinite(countdownProgress)) {
            console.warn('Invalid client-side countdown progress:', countdownProgress);
            countdownProgress = lastCountdownProgress || 100;
        }
        
        // Prevent progress bar from jumping backwards using the global tracking variable
        if (lastCountdownProgress !== null && countdownProgress > lastCountdownProgress) {
            // Allow small tolerance for rounding differences
            if (countdownProgress - lastCountdownProgress > 1) {
                countdownProgress = lastCountdownProgress;
            }
        }
        
        // Update the bar and tracking variable
        if (lastCountdownProgress === null || countdownProgress <= lastCountdownProgress) {
            countdownBar.style.width = `${countdownProgress}%`;
            lastCountdownProgress = countdownProgress;
        }
        
        // If countdown is nearly complete, ensure it shows as complete
        if (adjustedTimeRemaining < 1000) {
            countdownBar.style.width = '0%';
            lastCountdownProgress = 0;
        }
    }
}
// =============================================================================
// Explore on Bing Tasks
// =============================================================================

let _explorePanelVisible = false;

/**
 * Toggle the explore tasks panel open/closed and populate it with live data.
 */
function toggleExploreTasksPanel() {
    const panel = document.getElementById('explore-tasks-panel');
    if (!panel) return;

    _explorePanelVisible = !_explorePanelVisible;
    if (_explorePanelVisible) {
        panel.classList.add('visible');
        requestExploreTasksStatus();
    } else {
        panel.classList.remove('visible');
    }
}

/**
 * Request the current explore tasks status from the background script
 * and render them in the panel.
 */
function requestExploreTasksStatus() {
    chrome.runtime.sendMessage({ action: 'getExploreTasksStatus' }, response => {
        if (chrome.runtime.lastError) {
            console.warn('Explore tasks status error:', chrome.runtime.lastError.message);
            return;
        }
        renderExploreTasksPanel(response);
    });
}

/**
 * Renders the explore tasks panel with current task data.
 * @param {object} response - Response from background script's getExploreTasksStatus handler.
 */
function renderExploreTasksPanel(response) {
    const panel = document.getElementById('explore-tasks-panel');
    if (!panel) return;

    const exploreStatus = response && response.success ? response.exploreStatus : null;
    const tasks = exploreStatus && exploreStatus.tasks ? exploreStatus.tasks : [];
    const isRunning = exploreStatus && exploreStatus.jobStatus === 1 /* STATUS_BUSY */;
    const completed = exploreStatus ? exploreStatus.completedThisRun : 0;

    let tasksHtml = '';
    if (tasks.length === 0) {
        if (completed > 0) {
            tasksHtml = `<div style="color:#4a4; font-size:11px; padding: 4px 0;">&#10003; ${completed} task${completed > 1 ? 's' : ''} completed this session. No further tasks pending.</div>`;
        } else if (isRunning) {
            tasksHtml = '<div style="color:#666; font-size:11px; padding: 4px 0;">Fetching tasks...</div>';
        } else {
            tasksHtml = '<div style="color:#666; font-size:11px; padding: 4px 0;">No pending explore tasks found.<br>' +
                '<span style="color:#999;">All tasks may be complete for this week, not yet available on your account, or the fetch failed. ' +
                'Check the service worker console for details.</span></div>';
        }
    } else {
        tasks.forEach(task => {
            let badgeClass = 'badge-pending';
            let badgeText = '⏳ Pending';
            if (task.complete) {
                badgeClass = 'badge-complete';
                badgeText = '✓ Done';
            } else if (task.isActivated) {
                badgeClass = 'badge-activated';
                badgeText = '+ Active';
            }

            const pts = task.pointProgressMax > 0
                ? ` (+${task.pointProgressMax - task.pointProgress} pts)`
                : '';

            tasksHtml += `
                <div class="explore-task-row">
                    <span class="explore-task-title" title="${escapeHtml(task.description)}">${escapeHtml(task.title)}${pts}</span>
                    <span class="explore-task-badge ${badgeClass}">${badgeText}</span>
                </div>`;
        });
    }

    const runBtnLabel = isRunning ? 'Running...' : 'Run Now';
    const runBtnDisabled = isRunning ? 'disabled' : '';

    panel.innerHTML = `
        <div class="explore-tasks-header">
            <span>Explore on Bing Tasks${completed > 0 ? ` \u2014 ${completed} completed this session` : ''}</span>
            <button id="run-explore-tasks" class="explore-run-btn" ${runBtnDisabled}>${runBtnLabel}</button>
        </div>
        ${tasksHtml}`;

    // Wire up run button
    const runBtn = document.getElementById('run-explore-tasks');
    if (runBtn) {
        runBtn.addEventListener('click', () => {
            runBtn.disabled = true;
            runBtn.textContent = 'Starting...';
            chrome.runtime.sendMessage({ action: 'startExploreTasks' }, () => {
                setTimeout(requestExploreTasksStatus, 3000);
            });
        });
    }
}

/**
 * Simple HTML entity escaping to prevent XSS from task titles/descriptions.
 */
function escapeHtml(str) {
    return (str || '').replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}