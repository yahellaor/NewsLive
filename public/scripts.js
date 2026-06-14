// ===== Constants =====

const API_BASE = 'https://allnews-server-1018085155010.europe-west3.run.app';

const HEBREW_SOURCES = new Set(['ynet', 'maariv', 'n12', 'rotter', 'walla', 'haaretz']);

const SOURCE_KEY_MAP = {
    'BBC News': 'bbc', 'NYT News': 'nyt', 'Ynet News': 'ynet',
    'Maariv News': 'maariv', 'N12 News': 'n12', 'Rotter News': 'rotter',
    'Walla News': 'walla', 'Haaretz News': 'haaretz'
};

const ENDPOINTS = ['bbc', 'nyt', 'ynet', 'maariv', 'n12', 'rotter', 'walla', 'haaretz'];

const autoRefreshInterval = 30000;
const doubleTapDelay = 300;

// ===== Module state =====

let currentDisplayMode = 'list';
let lastSuccessfulUpdate = null;
let currentFontSize = 16;

let newsData = {};
let renderedItemKeys = new Set();
let isAutoRefreshEnabled = false;

let isFetching = false;
let nextFetchScheduled = false;
let currentAbortController = null;
let autoRefreshTimerId = null;
let searchDebounceId = null;

// Per-source state for the in-flight cycle: 'pending' | 'loaded' | 'failed' | 'retrying'
let cycleSourceStates = new Map();

// ===== Helpers =====

function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
        else node.setAttribute(k, v);
    }
    for (const child of children) appendChild(node, child);
    return node;
}

function appendChild(node, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) {
        for (const sub of child) appendChild(node, sub);
        return;
    }
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
}

function safeHttpUrl(value) {
    if (!value || typeof value !== 'string') return null;
    try {
        const u = new URL(value);
        return (u.protocol === 'http:' || u.protocol === 'https:') ? value : null;
    } catch {
        return null;
    }
}

// Parse HTML inertly (template content does not load resources or run scripts)
// and return the plain text representation.
function htmlToText(html) {
    if (!html || typeof html !== 'string') return '';
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    return tpl.content.textContent || '';
}

function formatMilitaryTime(date) {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

function formatFetchTimestamp(date) {
    return date.toLocaleString();
}

function getRelativeTime(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);
    if (diffMin < 1) return 'now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    if (diffDay === 1) return 'yesterday';
    return `${diffDay}d ago`;
}

function getItemKey(item) {
    return `${item.newsType}::${item.link || ''}::${item.title || ''}`;
}

function detectLanguage(text) {
    if (!text) return 'ltr';
    return /[֐-׿]/.test(text) ? 'rtl' : 'ltr';
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
            return;
        }
        const t = setTimeout(resolve, ms);
        if (signal) {
            signal.addEventListener('abort', () => {
                clearTimeout(t);
                const err = new Error('Aborted');
                err.name = 'AbortError';
                reject(err);
            }, { once: true });
        }
    });
}

// ===== Network =====

// Per-source fetch with one retry on transient errors. Owns the per-source
// AbortController and the 40s timeout that bounds a hung backend. Cycle abort
// (passed as `signal`) short-circuits both attempts. Per-source TimeoutError
// is retryable, identical to a network error.
async function fetchWithRetry(url, options = {}) {
    const { signal: cycleSignal, onRetry, timeoutMs = 40000 } = options;
    let attempt = 0;
    while (true) {
        // Per-attempt source controller, chained to the cycle signal so a
        // cycle abort propagates and cancels the in-flight request.
        const sourceController = new AbortController();
        let onCycleAbort;
        if (cycleSignal) {
            if (cycleSignal.aborted) {
                sourceController.abort(new DOMException('Cycle aborted', 'AbortError'));
            } else {
                onCycleAbort = () => sourceController.abort(new DOMException('Cycle aborted', 'AbortError'));
                cycleSignal.addEventListener('abort', onCycleAbort, { once: true });
            }
        }
        const timeoutId = setTimeout(
            () => sourceController.abort(new DOMException('Per-source timeout', 'TimeoutError')),
            timeoutMs
        );

        try {
            const res = await fetch(url, { signal: sourceController.signal });
            if (res.status >= 500) {
                if (attempt === 0) {
                    attempt++;
                    if (onRetry) onRetry();
                    try { await sleep(1500, cycleSignal); } catch (e) { throw e; }
                    continue;
                }
                throw new Error(`HTTP ${res.status}`);
            }
            return res;
        } catch (err) {
            // Cycle was aborted — propagate the abort, do not retry.
            if (cycleSignal && cycleSignal.aborted) throw err;
            // Otherwise (network error, 5xx after json, or per-source TimeoutError):
            // retry once after a backoff.
            if (attempt === 0) {
                attempt++;
                if (onRetry) onRetry();
                try { await sleep(1500, cycleSignal); } catch (e) { throw e; }
                continue;
            }
            throw err;
        } finally {
            clearTimeout(timeoutId);
            if (onCycleAbort && cycleSignal) cycleSignal.removeEventListener('abort', onCycleAbort);
        }
    }
}

async function fetchNews(endpoint, newsType, { render = true, signal, onRetry } = {}) {
    const checkbox = document.getElementById(`${endpoint}-checkbox`);
    if (!checkbox || !checkbox.checked) return;

    const response = await fetchWithRetry(`${API_BASE}/${endpoint}`, { signal, onRetry });
    const newsItems = await response.json();

    if (!checkbox.checked || (signal && signal.aborted)) return;

    newsData[endpoint] = newsItems.map(item => ({ ...item, newsType }));

    if (render) displayNewsItems();
}

async function fetchSelectedNews() {
    if (isFetching) {
        nextFetchScheduled = true;
        return;
    }
    isFetching = true;
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;

    const refreshButton = document.getElementById('refresh-button');
    if (refreshButton) {
        refreshButton.disabled = true;
        refreshButton.classList.add('refreshing');
    }

    cycleSourceStates = new Map();
    const failedEndpoints = [];

    try {
        const activeFetches = [];
        for (const endpoint of ENDPOINTS) {
            const checkbox = document.getElementById(`${endpoint}-checkbox`);
            if (checkbox && checkbox.checked) {
                activeFetches.push({ endpoint, name: checkbox.name });
                cycleSourceStates.set(endpoint, 'pending');
            }
        }

        if (activeFetches.length === 0) {
            displayNewsItems();
            return;
        }

        const isInitialRender = renderedItemKeys.size === 0;
        if (isInitialRender) {
            showSkeletonLoading(activeFetches.length);
        }
        renderStatusLine();

        let completed = 0;

        // Render each source as it arrives — don't wait for the slowest.
        // fetchNews with render: true triggers a reconcile per source, so the
        // first responder paints immediately and later ones stream in.
        const promises = activeFetches.map(({ endpoint, name }) => {
            const onRetry = () => {
                if (cycleSourceStates.get(endpoint) === 'pending') {
                    cycleSourceStates.set(endpoint, 'retrying');
                    renderStatusLine();
                }
            };
            return fetchNews(endpoint, name, { render: true, signal, onRetry })
                .then(() => {
                    completed++;
                    // User may have toggled this source off mid-cycle — only
                    // update state if it's still part of this cycle's accounting.
                    if (cycleSourceStates.has(endpoint)) {
                        cycleSourceStates.set(endpoint, 'loaded');
                        renderStatusLine();
                    }
                    if (isInitialRender) updateFetchProgress(completed, activeFetches.length);
                })
                .catch(error => {
                    completed++;
                    if (error.name === 'AbortError') {
                        // Cycle abort — don't mark as failed, don't surface in banner.
                        return;
                    }
                    if (cycleSourceStates.has(endpoint)) {
                        cycleSourceStates.set(endpoint, 'failed');
                        failedEndpoints.push(`${name} (${endpoint})`);
                        console.error(`Error fetching ${name}:`, error);
                        // Live banner update: surface failures the moment they're final.
                        displayFetchErrors(failedEndpoints);
                        renderStatusLine();
                    }
                    if (isInitialRender) updateFetchProgress(completed, activeFetches.length);
                });
        });

        await Promise.all(promises);

        if (signal.aborted) return;

        // Final pass: covers the all-sources-failed case where no per-source
        // render fired (catch path doesn't call displayNewsItems).
        displayNewsItems();

        const succeededCount = Array.from(cycleSourceStates.values()).filter(s => s === 'loaded').length;
        if (failedEndpoints.length === 0) {
            clearFetchErrors();
        } else {
            displayFetchErrors(failedEndpoints);
        }
        if (succeededCount > 0) {
            lastSuccessfulUpdate = new Date();
        }
    } finally {
        const statesArr = Array.from(cycleSourceStates.values());
        finalizeStatusLine({
            totalCount: statesArr.length,
            failedCount: statesArr.filter(s => s === 'failed').length,
            succeededCount: statesArr.filter(s => s === 'loaded').length,
            aborted: signal.aborted,
        });

        isFetching = false;
        currentAbortController = null;
        if (refreshButton) {
            refreshButton.disabled = false;
            refreshButton.classList.remove('refreshing');
        }

        if (nextFetchScheduled && !document.hidden) {
            nextFetchScheduled = false;
            queueMicrotask(() => fetchSelectedNews());
        } else {
            nextFetchScheduled = false;
            if (isAutoRefreshEnabled && !document.hidden) {
                scheduleNextFetch();
            }
        }
    }
}

// ===== Auto-refresh lifecycle =====

function scheduleNextFetch() {
    if (autoRefreshTimerId) clearTimeout(autoRefreshTimerId);
    autoRefreshTimerId = setTimeout(() => {
        autoRefreshTimerId = null;
        if (isAutoRefreshEnabled && !document.hidden) {
            fetchSelectedNews();
        }
    }, autoRefreshInterval);
}

function startAutoRefresh() {
    scheduleNextFetch();
}

function stopAutoRefresh() {
    if (autoRefreshTimerId) {
        clearTimeout(autoRefreshTimerId);
        autoRefreshTimerId = null;
    }
    if (currentAbortController) currentAbortController.abort();
}

function toggleAutoRefresh() {
    isAutoRefreshEnabled = !isAutoRefreshEnabled;
    const toggleButton = document.getElementById('auto-refresh-toggle');
    if (isAutoRefreshEnabled) {
        toggleButton.classList.remove('auto-refresh-off');
        toggleButton.classList.add('auto-refresh-on');
        toggleButton.title = 'Auto-refresh enabled (every 30s) - Click to disable';
        startAutoRefresh();
    } else {
        toggleButton.classList.remove('auto-refresh-on');
        toggleButton.classList.add('auto-refresh-off');
        toggleButton.title = 'Auto-refresh disabled - Click to enable';
        stopAutoRefresh();
    }
}

function refreshNews() {
    fetchSelectedNews();
}

function reloadPage() {
    location.reload();
}

// ===== Rendering =====

function showSkeletonLoading(count) {
    const newsContainer = document.getElementById('news-container');
    newsContainer.replaceChildren();
    newsContainer.appendChild(
        el('div', { class: 'fetch-progress' },
            el('div', { class: 'fetch-progress-bar', id: 'fetch-progress-bar', style: 'width: 0%' })
        )
    );
    const skeletonCount = Math.min(count * 3, 12);
    for (let i = 0; i < skeletonCount; i++) {
        newsContainer.appendChild(
            el('div', { class: 'skeleton-item' },
                el('div', { class: 'skeleton-line skeleton-title' }),
                el('div', { class: 'skeleton-line skeleton-text' }),
                el('div', { class: 'skeleton-line skeleton-text short' })
            )
        );
    }
}

function updateFetchProgress(completed, total) {
    const bar = document.getElementById('fetch-progress-bar');
    if (!bar) return;
    const pct = Math.round((completed / total) * 100);
    bar.style.width = `${pct}%`;
    if (pct >= 100) bar.classList.add('done');
}

function displayFetchErrors(failedEndpoints) {
    const errorContainer = document.getElementById('error-container');
    if (!errorContainer) return;
    if (!failedEndpoints || failedEndpoints.length === 0) {
        clearFetchErrors();
        return;
    }
    errorContainer.replaceChildren(`Failed to fetch news from: ${failedEndpoints.join(', ')}`);
    errorContainer.classList.add('has-errors');
}

function clearFetchErrors() {
    const errorContainer = document.getElementById('error-container');
    if (!errorContainer) return;
    errorContainer.classList.remove('has-errors');
    errorContainer.replaceChildren();
}

function buildEmptyState(anyChecked) {
    return el('div', { class: 'empty-state' },
        el('div', { class: 'empty-state-icon' }, anyChecked ? '⏳' : '📰'),
        el('div', { class: 'empty-state-text' }, anyChecked ? 'Loading news...' : 'No sources selected'),
        el('div', { class: 'empty-state-hint' }, anyChecked ? 'Fetching articles from your selected sources' : 'Tap on source icons above to start reading')
    );
}

function buildNewsItemNode(item, sourceKeyMap) {
    const pubDate = new Date(item.pubDate);
    const militaryTime = formatMilitaryTime(pubDate);
    const key = getItemKey(item);
    const titleText = htmlToText(item.title);
    const descText = htmlToText(item.description);
    const titleDir = detectLanguage(titleText);
    const descDir = detectLanguage(descText);
    const isHebrewSource = HEBREW_SOURCES.has(item.newsType);
    const sourceKey = sourceKeyMap[item.newsType] || '';
    const relTime = getRelativeTime(pubDate);
    const safeLink = safeHttpUrl(item.link);
    const safeThumb = safeHttpUrl(item.thumbnail);
    const sourceName = String(item.source || '');

    const anchorProps = (extra = {}) => safeLink
        ? { href: safeLink, target: '_blank', rel: 'noopener noreferrer', ...extra }
        : extra;

    let newsItem;

    if (currentDisplayMode === 'list') {
        const description = (item.newsType === 'maariv') ? '' : descText;
        const hasDescription = description && description.trim() !== '';

        const publisherSpan = el('span', { class: 'publisher' },
            '(',
            sourceKey ? el('span', { class: `source-dot ${sourceKey}` }) : null,
            el('a', anchorProps(), sourceName),
            ')'
        );

        const titleP = el('p', { dir: titleDir },
            el('strong', {}, militaryTime),
            el('span', { class: 'time-relative' }, relTime),
            ' - ',
            titleText,
            ' ',
            publisherSpan
        );

        const children = [titleP];
        if (hasDescription) {
            children.push(
                el('div', { class: 'news-description' },
                    el('p', { dir: descDir }, description),
                    el('a', anchorProps({ class: 'read-original-link' }), 'Read original →')
                )
            );
        }

        newsItem = el('div', { class: 'news-item-list' }, ...children);

        if (hasDescription) {
            newsItem.classList.add('expandable');
            newsItem.addEventListener('click', (e) => {
                if (e.target.tagName === 'A') return;
                const desc = newsItem.querySelector('.news-description');
                if (desc) {
                    desc.classList.toggle('open');
                    newsItem.classList.toggle('expanded');
                }
            });
        } else if (safeLink) {
            // Visual-only indicator: row is not clickable; source chip remains the link
            newsItem.classList.add('navigable');
        }
    } else {
        const h2 = el('h2', { dir: titleDir },
            el('span', { class: 'news-time' }, `[${militaryTime}]`),
            el('span', { class: 'time-relative' }, relTime),
            ' ',
            titleText
        );

        const cardChildren = [
            h2,
            el('p', { dir: descDir }, descText),
            el('a', anchorProps(), 'Read more'),
            el('p', {}, `Published on: ${pubDate.toLocaleString()}`)
        ];
        if (safeThumb) {
            cardChildren.push(el('img', { src: safeThumb, alt: 'Thumbnail' }));
        }
        cardChildren.push(
            el('p', { class: 'fetch-timestamp' }, `Fetched on: ${formatFetchTimestamp(new Date())}`)
        );
        cardChildren.push(
            el('p', { class: 'publisher' },
                sourceKey ? el('span', { class: `source-dot ${sourceKey}` }) : null,
                ` Publisher: ${sourceName}`
            )
        );

        newsItem = el('div', { class: 'news-item', dir: isHebrewSource ? 'rtl' : 'ltr' }, ...cardChildren);
    }

    newsItem.setAttribute('data-item-key', key);
    newsItem.classList.add(isHebrewSource ? 'hebrew-source' : 'english-source');
    return newsItem;
}

function reconcile(allNewsItems) {
    const newsContainer = document.getElementById('news-container');

    newsContainer.querySelectorAll('.skeleton-item, .fetch-progress, .empty-state').forEach(n => n.remove());

    if (allNewsItems.length === 0) {
        const anyChecked = Array.from(document.querySelectorAll('#buttons-container input[type="checkbox"]')).some(cb => cb.checked);
        newsContainer.querySelectorAll('.news-item, .news-item-list').forEach(n => n.remove());
        newsContainer.appendChild(buildEmptyState(anyChecked));
        renderedItemKeys = new Set();
        updateNewsCount();
        return;
    }

    const newKeys = new Set(allNewsItems.map(getItemKey));

    // Mark stale nodes for removal (fade out, then drop)
    const existingNodes = Array.from(newsContainer.querySelectorAll('.news-item, .news-item-list'));
    for (const node of existingNodes) {
        if (node.classList.contains('removing')) continue;
        const key = node.getAttribute('data-item-key');
        if (!newKeys.has(key)) {
            node.classList.add('removing');
            setTimeout(() => node.remove(), 200);
        }
    }

    // Map live (not .removing) existing nodes by key
    const existingByKey = new Map();
    newsContainer.querySelectorAll('.news-item:not(.removing), .news-item-list:not(.removing)').forEach(node => {
        const key = node.getAttribute('data-item-key');
        if (key) existingByKey.set(key, node);
    });

    // Walk sorted items; insert or move into position
    let prev = null;
    for (const item of allNewsItems) {
        const key = getItemKey(item);
        let node = existingByKey.get(key);
        const isNew = !node;
        if (isNew) {
            node = buildNewsItemNode(item, SOURCE_KEY_MAP);
            node.classList.add('new-item');
        }
        const target = prev ? prev.nextSibling : newsContainer.firstChild;
        if (node !== target) {
            newsContainer.insertBefore(node, target);
        }
        prev = node;
    }

    requestAnimationFrame(() => {
        newsContainer.querySelectorAll('.new-item').forEach(n => n.classList.remove('new-item'));
    });

    renderedItemKeys = newKeys;
    updateNewsCount();
}

function displayNewsItems() {
    let allNewsItems = [];
    for (const source in newsData) {
        if (newsData[source] && Array.isArray(newsData[source])) {
            allNewsItems = allNewsItems.concat(newsData[source]);
        }
    }

    allNewsItems.sort((a, b) => {
        const dateA = a.pubDate ? new Date(a.pubDate) : new Date(0);
        const dateB = b.pubDate ? new Date(b.pubDate) : new Date(0);
        if (isNaN(dateA.getTime()) || isNaN(dateB.getTime())) return 0;
        return dateB - dateA;
    });

    reconcile(allNewsItems);
    applyFontSize();
    applyFilter();
}

// ===== Display mode, source toggles, font size =====

function setDisplayMode(mode) {
    currentDisplayMode = mode;
    const listBtn = document.getElementById('list-mode-btn');
    const cardBtn = document.getElementById('card-mode-btn');
    if (listBtn && cardBtn) {
        listBtn.classList.toggle('active', mode === 'list');
        cardBtn.classList.toggle('active', mode === 'card');
    }
    // Different node shapes for list/card — force full rebuild
    renderedItemKeys = new Set();
    document.getElementById('news-container').replaceChildren();
    displayNewsItems();
}

function toggleSourceSelection(endpoint, newsType) {
    const checkbox = document.getElementById(`${endpoint}-checkbox`);
    if (checkbox && checkbox.checked) {
        fetchNews(endpoint, newsType);
    } else {
        delete newsData[endpoint];
        // If a cycle is in flight, drop this source from its accounting so
        // the indicator doesn't stay stuck at "n/total" waiting on a source
        // the user no longer wants.
        if (cycleSourceStates.has(endpoint)) {
            cycleSourceStates.delete(endpoint);
            renderStatusLine();
        }
        displayNewsItems();
    }
}

function adjustFontSize(change) {
    currentFontSize += change;
    if (currentFontSize < 12) currentFontSize = 12;
    if (currentFontSize > 24) currentFontSize = 24;
    applyFontSize();
    showFontSizeFeedback();
}

function applyFontSize() {
    const newsContainer = document.getElementById('news-container');
    if (!newsContainer) return;
    newsContainer.style.fontSize = `${currentFontSize}px`;
    newsContainer.querySelectorAll('.news-item, .news-item-list').forEach(item => {
        const heading = item.querySelector('h2');
        if (heading) heading.style.fontSize = `${currentFontSize + 2}px`;
        item.querySelectorAll('p:not(.publisher):not(.fetch-timestamp)').forEach(p => {
            p.style.fontSize = `${currentFontSize}px`;
        });
    });
    newsContainer.querySelectorAll('.news-description p').forEach(d => {
        d.style.fontSize = `${currentFontSize}px`;
    });
}

function showFontSizeFeedback() {
    let feedbackEl = document.getElementById('font-size-feedback');
    if (!feedbackEl) {
        feedbackEl = el('div', { id: 'font-size-feedback' });
        Object.assign(feedbackEl.style, {
            position: 'fixed', bottom: '120px', left: '50%',
            transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.7)',
            color: 'white', padding: '10px 20px', borderRadius: '20px',
            zIndex: '1000', transition: 'opacity 0.3s ease'
        });
        document.body.appendChild(feedbackEl);
    }
    feedbackEl.textContent = `Font size: ${currentFontSize}px`;
    feedbackEl.style.opacity = '1';
    clearTimeout(window.fontSizeFeedbackTimeout);
    window.fontSizeFeedbackTimeout = setTimeout(() => {
        feedbackEl.style.opacity = '0';
    }, 1500);
}

// ===== Search =====

function applyFilter() {
    const query = document.getElementById('search-bar').value.toLowerCase();
    filterNewsByQuery(query);
    updateSearchClearVisibility();
}

function filterNews() {
    applyFilter();
}

function filterNewsByQuery(query) {
    const newsContainer = document.getElementById('news-container');
    const allNewsItems = newsContainer.querySelectorAll('.news-item, .news-item-list');
    allNewsItems.forEach(item => {
        const titleNode = item.querySelector('p, h2');
        const descNode = item.querySelector('.news-description p');
        const title = (titleNode ? titleNode.textContent : '').toLowerCase();
        const description = (descNode ? descNode.textContent : '').toLowerCase();
        item.style.display = (title.includes(query) || description.includes(query)) ? '' : 'none';
    });
}

function clearSearch() {
    const searchBar = document.getElementById('search-bar');
    searchBar.value = '';
    applyFilter();
    searchBar.focus();
}

function updateSearchClearVisibility() {
    const searchBar = document.getElementById('search-bar');
    const clearBtn = document.getElementById('search-clear');
    if (clearBtn) clearBtn.classList.toggle('visible', searchBar.value.length > 0);
}

// ===== News count, last-updated =====

function updateNewsCount() {
    const elNode = document.getElementById('news-count');
    if (!elNode) return;
    let total = 0;
    for (const source in newsData) {
        if (newsData[source] && Array.isArray(newsData[source])) total += newsData[source].length;
    }
    elNode.textContent = `${total} article${total !== 1 ? 's' : ''}`;
}

// Status line — two writers only: in-progress (renderStatusLine) and terminal
// (finalizeStatusLine). Everything else MUST go through one of these.

function renderStatusLine() {
    const lastUpdatedEl = document.getElementById('last-updated');
    if (!lastUpdatedEl) return;
    const label = lastUpdatedEl.querySelector('.status-label');
    if (!label) return;

    const states = Array.from(cycleSourceStates.values());
    const total = states.length;
    if (total === 0) return;
    const settled = states.filter(s => s === 'loaded' || s === 'failed').length;
    const isRetrying = states.some(s => s === 'retrying');

    let text = `Updating (${settled}/${total})…`;
    if (isRetrying) text += ' · retrying';

    label.textContent = text;
    lastUpdatedEl.classList.remove('idle');
    lastUpdatedEl.classList.toggle('retrying', isRetrying);
    lastUpdatedEl.classList.add('updating');
}

function finalizeStatusLine({ totalCount, failedCount, succeededCount, aborted }) {
    const lastUpdatedEl = document.getElementById('last-updated');
    if (!lastUpdatedEl) return;
    const label = lastUpdatedEl.querySelector('.status-label');
    if (!label) return;

    lastUpdatedEl.classList.remove('updating', 'retrying');
    lastUpdatedEl.classList.add('idle');

    // Cycle aborted before any source settled — keep the prior terminal label.
    if (aborted && succeededCount === 0 && failedCount === 0) return;

    // All sources failed this cycle.
    if (totalCount > 0 && failedCount === totalCount && succeededCount === 0) {
        const now = new Date().toLocaleTimeString('en-US', { hour12: false });
        label.textContent = `Failed at ${now}`;
        return;
    }

    // At least one source succeeded — show the last successful time.
    if (lastSuccessfulUpdate) {
        const t = lastSuccessfulUpdate.toLocaleTimeString('en-US', { hour12: false });
        label.textContent = `Last updated ${t}`;
        return;
    }

    label.textContent = 'Last updated --:--:--';
}

// ===== Scroll handling =====

function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setupScrollHandler() {
    let isCompact = false;
    window.addEventListener('scroll', () => {
        const scrollToTopButton = document.getElementById('scroll-to-top');
        const footer = document.querySelector('footer');
        const sourcesNav = document.getElementById('sources-nav');
        const y = window.scrollY;
        if (!isCompact && y > 80) {
            isCompact = true;
            footer.classList.add('scrolled');
            scrollToTopButton.classList.add('visible');
            sourcesNav.classList.add('compact');
        } else if (isCompact && y < 20) {
            isCompact = false;
            footer.classList.remove('scrolled');
            scrollToTopButton.classList.remove('visible');
            sourcesNav.classList.remove('compact');
        }
    });
}

// ===== Checkbox / source-label handlers (preserved tap/dblclick logic) =====

function setupCheckboxHandlers() {
    const labels = document.querySelectorAll('#buttons-container label');
    labels.forEach(label => {
        const checkbox = label.querySelector('input[type="checkbox"]');
        if (!checkbox) return;

        const sourceId = checkbox.id.replace('-checkbox', '');
        const sourceName = checkbox.name;

        const newLabel = label.cloneNode(true);
        label.parentNode.replaceChild(newLabel, label);
        const newCheckbox = newLabel.querySelector('input[type="checkbox"]');

        let lastTapTime = 0;
        let currentTouchStartX = 0;
        let currentTouchStartY = 0;
        let currentIsTouchMoved = false;
        let tapTimer = null;
        let isDoubleTapActioned = false;
        let isDesktopDoubleClickDetected = false;

        if ('ontouchstart' in window) {
            newLabel.addEventListener('touchstart', (event) => {
                currentIsTouchMoved = false;
                currentTouchStartX = event.touches[0].clientX;
                currentTouchStartY = event.touches[0].clientY;
                const currentTime = Date.now();
                const tapLength = currentTime - lastTapTime;
                if (tapLength < doubleTapDelay && tapLength > 0) {
                    event.preventDefault();
                    clearTimeout(tapTimer);
                    isDoubleTapActioned = true;
                    newLabel.classList.add('highlight-selection');
                    setTimeout(() => newLabel.classList.remove('highlight-selection'), 300);
                    selectOnlyThisSource(sourceId, sourceName);
                    lastTapTime = 0;
                } else {
                    lastTapTime = currentTime;
                    isDoubleTapActioned = false;
                }
            });
            newLabel.addEventListener('touchmove', (event) => {
                const xDiff = Math.abs(event.touches[0].clientX - currentTouchStartX);
                const yDiff = Math.abs(event.touches[0].clientY - currentTouchStartY);
                if (xDiff > 10 || yDiff > 10) currentIsTouchMoved = true;
            });
            newLabel.addEventListener('touchend', () => {
                if (currentIsTouchMoved) return;
                clearTimeout(tapTimer);
                if (isDoubleTapActioned) {
                    isDoubleTapActioned = false;
                } else {
                    tapTimer = setTimeout(() => {
                        newCheckbox.checked = !newCheckbox.checked;
                        toggleSourceSelection(sourceId, sourceName);
                    }, doubleTapDelay);
                }
            });
            newCheckbox.addEventListener('click', (event) => event.preventDefault());
        }

        if (!('ontouchstart' in window) || window.navigator.maxTouchPoints === 0) {
            newLabel.addEventListener('dblclick', (event) => {
                event.preventDefault();
                isDesktopDoubleClickDetected = true;
                newLabel.classList.add('highlight-selection');
                setTimeout(() => newLabel.classList.remove('highlight-selection'), 300);
                selectOnlyThisSource(sourceId, sourceName);
                setTimeout(() => { isDesktopDoubleClickDetected = false; }, 250);
            });
            newLabel.addEventListener('click', (event) => {
                event.preventDefault();
                setTimeout(() => {
                    if (!isDesktopDoubleClickDetected) {
                        newCheckbox.checked = !newCheckbox.checked;
                        toggleSourceSelection(sourceId, sourceName);
                    }
                }, 200);
            });
        }
    });
}

function selectOnlyThisSource(selectedEndpoint, selectedNewsType) {
    // Abort any in-flight cycle — its source-state map is for the old
    // selection and would otherwise keep the indicator stuck at the wrong
    // count until those fetches settled.
    if (currentAbortController) currentAbortController.abort();
    const checkboxes = document.querySelectorAll('#buttons-container input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = false);
    document.getElementById(`${selectedEndpoint}-checkbox`).checked = true;
    newsData = {};
    renderedItemKeys = new Set();
    document.getElementById('news-container').replaceChildren();
    // Route through fetchSelectedNews so the new cycle gets proper accounting.
    // Single-flight handles the case where the prior cycle hasn't fully
    // unwound yet (nextFetchScheduled = true → microtask follow-up).
    fetchSelectedNews();
}

// ===== Toggle description (legacy entry kept for any external callers) =====

function toggleDescription(index) {
    const descriptionDiv = document.getElementById(`description-${index}`);
    const listItem = descriptionDiv ? descriptionDiv.closest('.news-item-list') : null;
    if (!descriptionDiv) return;
    if (descriptionDiv.classList.contains('open')) {
        descriptionDiv.classList.remove('open');
        if (listItem) listItem.classList.remove('expanded');
    } else {
        descriptionDiv.classList.add('open');
        if (listItem) listItem.classList.add('expanded');
    }
}

// ===== Search handler & reload button binding =====

function setupSearchHandler() {
    const searchBar = document.getElementById('search-bar');
    if (!searchBar) return;
    searchBar.addEventListener('input', () => {
        if (searchDebounceId) clearTimeout(searchDebounceId);
        searchDebounceId = setTimeout(() => {
            searchDebounceId = null;
            applyFilter();
        }, 150);
    });
}

function setupReloadButton() {
    const reloadImg = document.querySelector('.reload-btn img');
    if (reloadImg) reloadImg.addEventListener('click', reloadPage);
}

// ===== Lifecycle: visibility & BFCache =====

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (autoRefreshTimerId) {
            clearTimeout(autoRefreshTimerId);
            autoRefreshTimerId = null;
        }
        if (currentAbortController) currentAbortController.abort();
    } else if (isAutoRefreshEnabled) {
        fetchSelectedNews();
    }
});

window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    const toggleButton = document.getElementById('auto-refresh-toggle');
    isAutoRefreshEnabled = !!(toggleButton && toggleButton.classList.contains('auto-refresh-on'));
    if (isAutoRefreshEnabled && !document.hidden) scheduleNextFetch();
});

// ===== DOMContentLoaded =====

document.addEventListener('DOMContentLoaded', () => {
    const checkboxes = document.querySelectorAll('#buttons-container input[type="checkbox"]');
    const uncheckedByDefault = ['bbc', 'nyt'];
    checkboxes.forEach(cb => {
        const endpoint = cb.id.replace('-checkbox', '');
        cb.checked = !uncheckedByDefault.includes(endpoint);
    });

    setupCheckboxHandlers();
    setupScrollHandler();
    setupSearchHandler();
    setupReloadButton();

    document.getElementById('news-container').style.fontSize = `${currentFontSize}px`;

    fetchSelectedNews();

    const autoRefreshButton = document.getElementById('auto-refresh-toggle');
    if (autoRefreshButton) {
        autoRefreshButton.classList.add('auto-refresh-off');
        autoRefreshButton.classList.remove('auto-refresh-on');
        autoRefreshButton.title = 'Auto-refresh disabled - Click to enable';
    }

    // ?stream=true: enable auto-refresh + kiosk tweaks
    try {
        const params = new URLSearchParams(window.location.search);
        if ((params.get('stream') || '').toLowerCase() === 'true') {
            isAutoRefreshEnabled = true;
            if (autoRefreshButton) {
                autoRefreshButton.classList.remove('auto-refresh-off');
                autoRefreshButton.classList.add('auto-refresh-on');
                autoRefreshButton.title = 'Auto-refresh enabled (every 30s) - Click to disable';
            }
            startAutoRefresh();
            try {
                document.body.style.zoom = '95%';
            } catch {
                document.documentElement.style.transform = 'scale(0.95)';
                document.documentElement.style.transformOrigin = 'top center';
            }
            setTimeout(() => { window.scrollBy(0, 195); }, 1050);
        }
    } catch (err) {
        console.error('Error parsing URL parameters for stream mode:', err);
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
            e.preventDefault();
            document.getElementById('search-bar').focus();
        }
        if (e.key === 'Escape' && document.activeElement.id === 'search-bar') {
            document.getElementById('search-bar').blur();
        }
    });
});
