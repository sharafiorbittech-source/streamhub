/* =========================================
   STREAMHUB — Frontend Application Logic
   ========================================= */

(function () {
  'use strict';

  // ========================================
  // STATE
  // ========================================
  let currentSport = 'all';
  let currentSection = 'live';
  let allEvents = [];
  let hlsInstance = null;
  let hlsM3u8Instance = null;
  let autoRefreshTimer = null;

  // ========================================
  // DOM REFS
  // ========================================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const eventsGrid = $('#events-grid');
  const loadingState = $('#loading-state');
  const eventCount = $('#event-count');
  const statLive = $('#stat-live');
  const statTotal = $('#stat-total');
  const btnRefresh = $('#btn-refresh');
  const toastContainer = $('#toast-container');

  // Player
  const sectionPlayer = $('#section-player');
  const playerTitle = $('#player-title');
  const streamIframe = $('#stream-iframe');
  const hlsPlayer = $('#hls-player');
  const btnClosePlayer = $('#btn-close-player');

  // ========================================
  // SPORT EMOJI MAP
  // ========================================
  const sportEmojis = {
    football: '⚽', basketball: '🏀', baseball: '⚾',
    hockey: '🏒', boxing: '🥊', mma: '🥋',
    tennis: '🎾', cricket: '🏏', golf: '⛳',
    racing: '🏎️', rugby: '🏉', volleyball: '🏐',
    other: '🎯',
  };

  // ========================================
  // TOAST NOTIFICATIONS
  // ========================================
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  // ========================================
  // FETCH EVENTS FROM BACKEND
  // ========================================
  async function fetchEvents(sport = 'all') {
    try {
      const params = sport !== 'all' ? `?sport=${sport}` : '';
      const res = await fetch(`/api/events${params}`);
      const data = await res.json();
      if (data.success) {
        allEvents = data.events;
        renderEvents(data.events);
        updateStats(data);
      }
    } catch (err) {
      console.error('Error fetching events:', err);
      showToast('Failed to fetch events. Retrying...', 'error');
      // Show demo events as fallback
      renderDemoEvents();
    }
  }

  // ========================================
  // REFRESH EVENTS (Force Scrape)
  // ========================================
  async function refreshEvents() {
    btnRefresh.classList.add('spinning');
    showToast('Refreshing events...', 'info');

    try {
      const res = await fetch('/api/events/refresh');
      const data = await res.json();
      if (data.success) {
        allEvents = data.events;
        renderEvents(data.events);
        updateStats(data);
        showToast(`Found ${data.count} events`, 'success');
      }
    } catch (err) {
      showToast('Refresh failed', 'error');
    } finally {
      btnRefresh.classList.remove('spinning');
    }
  }

  // ========================================
  // RENDER EVENTS
  // ========================================
  function renderEvents(events) {
    loadingState.classList.add('hidden');
    eventsGrid.innerHTML = '';

    if (events.length === 0) {
      eventsGrid.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📡</div>
          <p>No live streams found right now</p>
          <p class="empty-sub">Streams will appear here automatically when events go live.</p>
          <p class="empty-sub" style="margin-top: 12px;">
            You can also add custom streams using the <strong>➕ Add Stream</strong> section,<br>
            or paste an M3U8 URL in the <strong>🎬 M3U8 Player</strong>.
          </p>
        </div>
      `;
      return;
    }

    events.forEach((event, i) => {
      const card = document.createElement('div');
      card.className = 'event-card card-enter';
      card.style.animationDelay = `${i * 0.06}s`;

      const emoji = sportEmojis[event.sport] || '🎯';
      const sportName = event.sport.charAt(0).toUpperCase() + event.sport.slice(1);

      card.innerHTML = `
        <div class="event-card-header">
          <span class="event-sport-badge">${emoji} ${sportName}</span>
          ${event.isLive ? '<span class="event-live-badge">● LIVE</span>' : ''}
        </div>
        <div class="event-title">${escapeHtml(event.title)}</div>
        <div class="event-meta">
          <div class="event-actions">
            <button class="btn-watch" data-id="${event.id}">
              ▶ Watch
            </button>
          </div>
        </div>
      `;

      const handleWatch = async (eventId) => {
        const ev = allEvents.find(x => x.id === eventId);
        if (!ev) return;
        
        console.log(`[WATCH] Opening ${ev.title}...`);
        
        // Show player box immediately to indicate loading
        playerTitle.textContent = `⏳ Loading: ${ev.title}`;
        sectionPlayer.classList.remove('hidden');
        sectionPlayer.scrollIntoView({ behavior: 'smooth' });
        
        if (ev.hasM3u8) {
           // showToast('Loading direct stream...', 'info');
           try {
             const mReq = await fetch(`/api/m3u8-link/${encodeURIComponent(ev.id)}`);
             const mRes = await mReq.json();
             if (mRes.success && mRes.m3u8Url) {
                return openHLSPlayer(`/api/proxy-hls?url=${encodeURIComponent(mRes.m3u8Url)}`, ev.title);
             }
           } catch(e) {}
        }
        
        // showToast('Extracting smooth stream...', 'info');
        try {
          const res = await fetch(`/api/extract?id=${encodeURIComponent(ev.id)}`);
          const data = await res.json();
          
          if (data.success && data.m3u8Links && data.m3u8Links.length > 0) {
            const m3u8Url = data.m3u8Links[0];
            const proxiedM3u8 = `/api/proxy-hls?url=${encodeURIComponent(m3u8Url)}`;
            openHLSPlayer(proxiedM3u8, ev.title);
          } else if (data.success && data.iframeSrcs && data.iframeSrcs.length > 0) {
            openIframePlayerById(ev.id, ev.title, ev.source, data.iframeSrcs[0]);
          } else {
            openIframePlayerById(ev.id, ev.title, ev.source);
          }
        } catch (err) {
          // showToast('Failed to extract. Trying secure proxy...', 'error');
          openIframePlayerById(ev.id, ev.title, ev.source);
        }
      };

      // Watch button click
      card.querySelector('.btn-watch').addEventListener('click', (e) => {
        e.stopPropagation();
        handleWatch(e.currentTarget.dataset.id);
      });

      // Full card click => watch
      card.addEventListener('click', () => {
        handleWatch(event.id);
      });

      eventsGrid.appendChild(card);
    });
  }

  // ========================================
  // DEMO EVENTS (fallback when no server)
  // ========================================
  function renderDemoEvents() {
    const demoEvents = [
      { id: 'demo1', title: 'Add your first stream using the ➕ button', sport: 'other', isLive: false, source: 'StreamHub', embedUrl: '', url: '' },
      { id: 'demo2', title: 'Or paste an M3U8 URL in the 🎬 Player', sport: 'other', isLive: false, source: 'StreamHub', embedUrl: '', url: '' },
    ];
    loadingState.classList.add('hidden');
    renderEvents(demoEvents);
  }

  // ========================================
  // OPEN IFRAME PLAYER
  // ========================================
  function openIframePlayerById(id, title, source = 'StreamEast', directUrl = null) {
    if (!id) {
      showToast('Stream ID missing', 'error');
      return;
    }

    // Use the proxy-stream endpoint or custom target URL
    let finalUrl = `/api/proxy-stream?id=${encodeURIComponent(id)}`;
    if (directUrl) {
      finalUrl = `/api/proxy-stream?url=${encodeURIComponent(directUrl)}`;
    }
    
    // Add sandbox to prevent unauthorized popups and redirects while allowing stream playback
    streamIframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-presentation');
    streamIframe.setAttribute('allowfullscreen', 'true');
    
    streamIframe.src = finalUrl;
    streamIframe.classList.add('active');
    hlsPlayer.classList.remove('active');

    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }

    playerTitle.textContent = `▶ ${title}`;

    sectionPlayer.classList.remove('hidden');
    sectionPlayer.scrollIntoView({ behavior: 'smooth' });
    // showToast('Connecting to secure stream...', 'info');
  }

  // ========================================
  // OPEN HLS PLAYER (m3u8)
  // ========================================
  function openHLSPlayer(m3u8Url, title) {
    hlsPlayer.classList.add('active');
    streamIframe.classList.remove('active');
    streamIframe.src = '';

    if (hlsInstance) {
      hlsInstance.destroy();
    }

    if (Hls.isSupported()) {
      hlsInstance = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90
      });
      hlsInstance.loadSource(m3u8Url);
      hlsInstance.attachMedia(hlsPlayer);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        hlsPlayer.play().catch(() => {});
      });
      hlsInstance.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          showToast('Stream error. Trying to reconnect...', 'error');
          hlsInstance.destroy();
          setTimeout(() => openHLSPlayer(m3u8Url, title), 3000);
        }
      });
    } else if (hlsPlayer.canPlayType('application/vnd.apple.mpegurl')) {
      hlsPlayer.src = m3u8Url;
      hlsPlayer.addEventListener('loadedmetadata', () => {
        hlsPlayer.play().catch(() => {});
      });
    } else {
      showToast('HLS not supported in this browser', 'error');
      return;
    }

    playerTitle.textContent = `▶ ${title}`;

    sectionPlayer.classList.remove('hidden');
    sectionPlayer.scrollIntoView({ behavior: 'smooth' });
    // showToast('HLS stream loading...', 'success');
  }

  // ========================================
  // UPDATE STATS
  // ========================================
  function updateStats(data) {
    const liveCount = data.events.filter(e => e.isLive).length;
    animateNumber(statLive, liveCount);
    animateNumber(statTotal, data.count);
    eventCount.textContent = `${data.count} event${data.count !== 1 ? 's' : ''}`;

    // Update Nav Live Count
    const navLive = document.getElementById('nav-live-count');
    if (navLive) navLive.innerHTML = `🔴 Live Now (${liveCount})`;

    // Update Filter Chips Count Dynamically
    const counts = { all: data.count };
    data.events.forEach(e => {
        counts[e.sport] = (counts[e.sport] || 0) + 1;
    });

    document.querySelectorAll('.sport-chip').forEach(chip => {
        const sport = chip.dataset.sport;
        const count = counts[sport] || 0;
        const emoji = sportEmojis[sport] || (sport === 'all' ? '🌐' : '🎯');
        const name = sport.charAt(0).toUpperCase() + sport.slice(1);
        chip.innerHTML = `${emoji} ${name} (${count})`;
    });
  }

  function animateNumber(el, target) {
    const current = parseInt(el.textContent) || 0;
    if (current === target) return;
    const step = target > current ? 1 : -1;
    let val = current;
    const interval = setInterval(() => {
      val += step;
      el.textContent = val;
      if (val === target) clearInterval(interval);
    }, 50);
  }

  // ========================================
  // SECTION NAVIGATION
  // ========================================
  function switchSection(section) {
    currentSection = section;
    // Hide all sections
    $$('.section').forEach(s => s.classList.add('hidden'));
    // Show target
    const target = $(`#section-${section}`);
    if (target) target.classList.remove('hidden');

    // Also always show player if it was open
    if (!sectionPlayer.classList.contains('hidden') && section !== 'live') {
      // keep player visible
    }

    // Update nav
    $$('.nav-link').forEach(link => {
      link.classList.toggle('active', link.dataset.section === section);
    });

    // If sports section, ensure live section also visible
    if (section === 'live') {
      fetchEvents(currentSport);
    }
  }

  // ========================================
  // UTILITY
  // ========================================
  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ========================================
  // PARTICLES (simple decorative)
  // ========================================
  function initParticles() {
    const container = $('#particles');
    if (!container) return;
    for (let i = 0; i < 20; i++) {
      const p = document.createElement('div');
      p.style.cssText = `
        position: absolute;
        width: ${Math.random() * 4 + 2}px;
        height: ${Math.random() * 4 + 2}px;
        background: rgba(99, 102, 241, ${Math.random() * 0.3 + 0.1});
        border-radius: 50%;
        top: ${Math.random() * 100}%;
        left: ${Math.random() * 100}%;
        animation: float ${Math.random() * 8 + 4}s ease-in-out infinite;
        animation-delay: ${Math.random() * 4}s;
      `;
      container.appendChild(p);
    }

    const style = document.createElement('style');
    style.textContent = `
      @keyframes float {
        0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.4; }
        50% { transform: translate(${Math.random() > 0.5 ? '' : '-'}${Math.random() * 40 + 10}px, -${Math.random() * 30 + 10}px) scale(1.5); opacity: 0.8; }
      }
    `;
    document.head.appendChild(style);
  }

  // ========================================
  // EVENT LISTENERS
  // ========================================
  function initListeners() {
    // Nav links
    $$('.nav-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        switchSection(link.dataset.section);
      });
    });

    // Sport filter chips
    $$('.sport-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        currentSport = chip.dataset.sport;
        $$('.sport-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        fetchEvents(currentSport);
      });
    });

    // Sport cards (in browse section)
    $$('.sport-card').forEach(card => {
      card.addEventListener('click', () => {
        const sport = card.dataset.sport;
        currentSport = sport;
        $$('.sport-chip').forEach(c => {
          c.classList.toggle('active', c.dataset.sport === sport);
        });
        switchSection('live');
        fetchEvents(sport);
      });
    });

    // Refresh button
    btnRefresh.addEventListener('click', refreshEvents);

    // Close player
    btnClosePlayer.addEventListener('click', () => {
      sectionPlayer.classList.add('hidden');
      streamIframe.src = '';
      hlsPlayer.pause();
      if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
      }
    });

    // Header scroll effect
    window.addEventListener('scroll', () => {
      const header = $('#main-header');
      header.classList.toggle('scrolled', window.scrollY > 50);
    });

    // Logo click => home
    $('#logo').addEventListener('click', () => {
      switchSection('live');
      currentSport = 'all';
      $$('.sport-chip').forEach(c => c.classList.toggle('active', c.dataset.sport === 'all'));
      fetchEvents('all');
    });
  }

  // ========================================
  // AUTO REFRESH (every 2 min)
  // ========================================
  function startAutoRefresh() {
    autoRefreshTimer = setInterval(() => {
      console.log('[AUTO-REFRESH] Fetching latest events...');
      fetchEvents(currentSport);
    }, 2 * 60 * 1000);
  }

  // ========================================
  // INIT
  // ========================================
  function init() {
    initParticles();
    initListeners();
    fetchEvents('all');
    startAutoRefresh();
  }

  // Start when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
