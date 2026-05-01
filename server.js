const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

const https = require('https');
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
axios.defaults.httpsAgent = httpsAgent;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors *;");
  next();
});

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

let cachedEvents = [];
let lastFetch = null;

function detectSport(title) {
  const t = title.toLowerCase();
  if (t.match(/soccer|epl|premier|la liga|bundesliga|serie a|ligue|champions|mls|fifa|football/)) return 'football';
  if (t.match(/nba|basketball|ncaab|wnba/)) return 'basketball';
  if (t.match(/nfl|american football/)) return 'nfl';
  if (t.match(/mlb|baseball/)) return 'baseball';
  if (t.match(/nhl|hockey/)) return 'hockey';
  if (t.match(/boxing|knockout|bout|prizefight/)) return 'boxing';
  if (t.match(/ufc|mma|bellator|pfl/)) return 'mma';
  if (t.match(/tennis|atp|wta|wimbledon|open/)) return 'tennis';
  if (t.match(/cricket|ipl|test match/)) return 'cricket';
  if (t.match(/golf|pga|masters/)) return 'golf';
  if (t.match(/f1|formula|nascar|indycar|racing|grand prix/)) return 'racing';
  return 'other';
}

async function fetchStreamCenterEvents() {
  try {
    const res = await axios.get('https://backend.streamcenter.live/api/Parties?pageNumber=1&pageSize=100', { timeout: 10000 });
    const events = [];
    res.data.forEach(ev => {
      let sport = 'other';
      if (ev.categoryId === 17) sport = 'mma';
      if (ev.categoryId === 4) sport = 'basketball';
      if (ev.categoryId === 16) sport = 'hockey';
      if (ev.categoryId === 13) sport = 'baseball';
      if (ev.categoryId === 9) sport = 'nfl';
      
      let embedUrl = ev.videoUrl || ev.url || '';
      if (embedUrl.includes('<iframe')) {
        const match = embedUrl.match(/src=["']([^"']+)["']/);
        if (match) embedUrl = match[1];
      } else {
        const parts = embedUrl.split('<');
        if (parts.length > 0) embedUrl = parts[0].trim();
      }
      
      if (embedUrl && embedUrl.startsWith('http')) {
        events.push({
          id: 'sc_' + ev.id,
          title: ev.name || ev.gameName,
          sport: sport,
          isLive: true,
          embedUrl: embedUrl,
          url: embedUrl,
          source: 'StreamCenter',
          fetchedAt: new Date().toISOString()
        });
      }
    });
    return events;
  } catch (e) {
    console.error("StreamCenter Error:", e.message);
    return [];
  }
}

async function fetchStreamEastEvents() {
  const events = [];
  try {
    const res = await axios.get('https://streameast.to/', { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(res.data);
    const seen = new Set();
    
    $('.match-card, a[href*="/nba/"], a[href*="/nfl/"], a[href*="/soccer/"], a[href*="/boxing/"]').each((i, el) => {
      const link = $(el).attr('href') || $(el).find('a').attr('href') || '';
      const title = $(el).text().trim().replace(/\s+/g, ' ');
      if (!link || seen.has(link) || title.length < 5) return;
      seen.add(link);
      
      const fullLink = link.startsWith('http') ? link : 'https://streameast.to' + link;
      events.push({
        id: 'se_' + Date.now() + '_' + i,
        title: title.substring(0, 150),
        url: fullLink,
        sport: detectSport(title + ' ' + link),
        isLive: true,
        embedUrl: fullLink,
        source: 'StreamEast',
        fetchedAt: new Date().toISOString()
      });
    });
  } catch (e) {
    console.error("StreamEast Error:", e.message);
  }
  return events;
}

async function fetchAllEvents() {
  console.log("Fetching live events...");
  const scEvents = await fetchStreamCenterEvents();
  const seEvents = await fetchStreamEastEvents();
  const all = [...scEvents, ...seEvents];
  if (all.length > 0) {
    cachedEvents = all;
    lastFetch = new Date().toISOString();
  }
}

setInterval(fetchAllEvents, 2 * 60 * 1000);
fetchAllEvents();

app.get('/api/events', (req, res) => {
  const sport = req.query.sport;
  let filtered = sport && sport !== 'all' ? cachedEvents.filter(e => e.sport === sport) : cachedEvents;
  res.json({
    success: true,
    lastFetch,
    count: filtered.length,
    events: filtered.map(e => ({ ...e, hasM3u8: false }))
  });
});

app.get('/api/events/refresh', async (req, res) => {
  await fetchAllEvents();
  res.json({
    success: true,
    lastFetch,
    count: cachedEvents.length,
    events: cachedEvents.map(e => ({ ...e, hasM3u8: false }))
  });
});

app.get('/api/m3u8-link/:id', (req, res) => {
  const ev = cachedEvents.find(e => e.id === req.params.id);
  if (!ev || !ev.m3u8Url) return res.status(404).json({ error: 'M3U8 not found' });
  res.json({ success: true, m3u8Url: ev.m3u8Url });
});

app.get('/api/extract', async (req, res) => {
  const { url, id } = req.query;
  let targetUrl = url;
  if (id) {
    const ev = cachedEvents.find(e => e.id === id);
    if (ev) targetUrl = ev.embedUrl || ev.url;
  }
  if (!targetUrl) return res.status(400).json({ error: 'URL required' });

  try {
    const response = await axios.get(targetUrl, { headers: HEADERS, timeout: 15000, validateStatus: () => true });
    let html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    
    let iframeSrcs = [];
    const iframes = html.match(/<iframe[^>]+src=["']([^"']+)["']/gi);
    if (iframes) {
        iframes.forEach(iframe => {
            const match = iframe.match(/src=["']([^"']+)["']/i);
            if (match) iframeSrcs.push(match[1].startsWith('http') ? match[1] : 'https:' + match[1]);
        });
    }

    if (targetUrl.includes('streams.center')) {
      const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']*hls\.php[^"']*)["']/i);
      let decryptUrl = targetUrl;
      if (iframeMatch) {
         let src = iframeMatch[1];
         if (src.startsWith('//')) src = 'https:' + src;
         else if (!src.startsWith('http')) src = new URL(src, targetUrl).href;
         decryptUrl = src;
      }
      
      const decryptRes = await axios.get(decryptUrl, { headers: { ...HEADERS, Referer: targetUrl }, timeout: 10000 });
      const inputMatch = decryptRes.data.match(/input:\s*["']([^"']+)["']/);
      if (inputMatch) {
          const actionUrl = new URL('decrypt.php', decryptUrl).href;
          const decodedRes = await axios.post(actionUrl, new URLSearchParams({ input: inputMatch[1] }), {
              headers: { ...HEADERS, Referer: decryptUrl, 'Content-Type': 'application/x-www-form-urlencoded' }
          });
          const m3u8 = decodedRes.data.trim();
          if (m3u8 && m3u8.includes('.m3u8')) {
              return res.json({ success: true, m3u8Links: [m3u8], iframeSrcs });
          }
      }
    }
    
    const m3u8Regex = /https?:\/\/[^\s"'<>\]]+\.m3u8[^\s"'<>\]]*/gi;
    const links = html.match(m3u8Regex) || [];
    res.json({ success: true, m3u8Links: [...new Set(links)], iframeSrcs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// HTML PROXY TO REMOVE ADS
app.get('/api/proxy-stream', async (req, res) => {
  let { id, url } = req.query;
  let targetUrl = url;
  if (id) {
    const ev = cachedEvents.find(e => e.id === id);
    if (ev) targetUrl = ev.embedUrl || ev.url;
  }
  if (!targetUrl) return res.status(400).send('Stream URL required');

  try {
    let response = await axios.get(targetUrl, {
      headers: { ...HEADERS, Referer: 'https://streamcenter.live/' },
      timeout: 15000,
      responseType: 'text',
      maxRedirects: 5
    });
    
    let html = response.data;
    
    if (targetUrl.includes('streams.center')) {
       const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']*hls\.php[^"']*)["']/i);
       if (iframeMatch) {
           let src = iframeMatch[1];
           if (src.startsWith('//')) src = 'https:' + src;
           else if (!src.startsWith('http')) src = new URL(src, targetUrl).href;
           
           response = await axios.get(src, {
              headers: { ...HEADERS, Referer: targetUrl },
              timeout: 15000,
              responseType: 'text',
              maxRedirects: 5
           });
           html = response.data;
           targetUrl = src;
       }
    }
    
    const urlObj = new URL(targetUrl);
    const baseHref = urlObj.origin + urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);
    
    html = html.replace(/<head>/i, `<head>\n<base href="${baseHref}">\n`);
    
    const adBlocker = `
         <style>
            [class*="popunder"], [id*="popunder"], [class*="ad-"], [class*="ads-"],
            [id*="ad-"], [id*="ads-"], .ac-overlay, .overlay-ads, #histats,
            [style*="z-index: 2147483647"], [style*="z-index:99999"], .modal-backdrop,
            iframe[src*="adservice"], iframe[src*="doubleclick"], .pop-ads-bg {
                display: none !important;
                visibility: hidden !important;
                opacity: 0 !important;
                pointer-events: none !important;
            }
         </style>
         <script>
            (function() {
                const originalOpen = window.open;
                window.open = function() { console.log("Blocked Popup"); return { focus: function(){} }; };
                window.onbeforeunload = null;
                window.alert = function() {};
                window.confirm = function() { return true; };
                window.addEventListener('beforeunload', (e) => {
                    if (document.activeElement && document.activeElement.tagName !== 'IFRAME') {
                        e.preventDefault();
                        e.returnValue = '';
                    }
                });
            })();
         </script>
    `;
    html = html.replace('</head>', adBlocker + '</head>');
    html = html.replace(/<script[^>]*src=["'][^"']*(mellowads|ad-maven|exoclick|juicyads|popads|propellerads|popcash|onclick|syndication|histats|aclib)[^"']*["'][^>]*><\/script>/gi, '');
    html = html.replace(/<script[^>]*>.*?location\.href.*?<\/script>/gi, '');
    
    res.setHeader('Content-Type', 'text/html');
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', "frame-ancestors *;");
    res.send(html);
  } catch (e) {
    res.status(500).send("Proxy stream error: " + e.message);
  }
});

// HLS PROXY
app.get('/api/proxy-hls', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("URL required");

    try {
        const isM3u8 = targetUrl.includes('.m3u8');
        const response = await axios({
            url: targetUrl,
            method: 'GET',
            responseType: isM3u8 ? 'text' : 'stream',
            headers: {
                'User-Agent': USER_AGENT,
                'Referer': targetUrl.includes('streameast') ? 'https://streameast.to/' : 'https://streams.center/'
            },
            timeout: 15000
        });
        
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        if (isM3u8) {
            let data = response.data;
            const lines = data.split('\n');
            const modifiedLines = lines.map(line => {
                const tline = line.trim();
                if (!tline) return line;
                if (tline.startsWith('#EXT-X-STREAM-INF') || tline.startsWith('#EXTINF')) return line;
                if (tline.startsWith('#')) {
                    if (tline.startsWith('#EXT-X-KEY')) {
                        return tline.replace(/URI="([^"]+)"/, (m, p1) => {
                            const absUrl = p1.startsWith('http') ? p1 : new URL(p1, targetUrl).href;
                            return `URI="/api/proxy-hls?url=${encodeURIComponent(absUrl)}"`;
                        });
                    }
                    return line;
                }
                let absoluteUrl = tline.startsWith('http') ? tline : new URL(tline, targetUrl).href;
                return `/api/proxy-hls?url=${encodeURIComponent(absoluteUrl)}`;
            });
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.send(modifiedLines.join('\n'));
        } else {
            const contentType = response.headers['content-type'];
            if (contentType) res.setHeader('Content-Type', contentType);
            response.data.pipe(res);
        }
    } catch (e) {
        console.error("Proxy error:", targetUrl, e.message);
        res.status(500).send("Proxy error");
    }
});

app.listen(PORT, () => {
  console.log(`🚀 StreamHub Cloud running on port ${PORT}`);
});
