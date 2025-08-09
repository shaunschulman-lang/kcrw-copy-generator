
export async function handler(event, context) {
  try {
    const url = new URL(event.rawUrl || `http://x/?${event.rawQuery || ''}`);
    const sponsor = url.searchParams.get('sponsor') || '';
    const website = url.searchParams.get('website') || '';

    if (!sponsor) {
      return resp(400, { error: 'Missing sponsor' });
    }

    const sources = [];
    const facts = new Set();

    // Fetch website homepage (if provided)
    if (website) {
      const site = normalizeSite(website);
      try {
        const html = await fetch(`https://${site}`, { redirect: 'follow' }).then(r => r.text());
        const siteFacts = extractFactsFromHtml(html);
        siteFacts.forEach(f => facts.add(f));
        sources.push({ type: 'website', url: `https://${site}` });
      } catch (e) {
        // ignore site fetch errors
      }
    }

    // Wikipedia Search + Extract
    try {
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(sponsor)}&format=json`;
      const sres = await fetch(searchUrl).then(r => r.json());
      if (sres && sres.query && sres.query.search && sres.query.search[0]) {
        const pageid = sres.query.search[0].pageid;
        const pageUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts|pageprops|info&exintro=1&explaintext=1&inprop=url&pageids=${pageid}&format=json`;
        const pres = await fetch(pageUrl).then(r => r.json());
        if (pres && pres.query && pres.query.pages) {
          const page = pres.query.pages[pageid];
          const extract = (page.extract || '').replace(/\(.*?\)/g, '').replace(/—/g, ' ');
          const first = extract.split(/[\.\n]/)[0];
          if (first) facts.add(cleanSentence(first));
          sources.push({ type: 'wikipedia', url: page.fullurl || `https://en.wikipedia.org/?curid=${pageid}` });
        }
      }
    } catch (e) {
      // ignore wiki errors
    }

    // If still too few, try meta description from DuckDuckGo lite (no key)
    if (facts.size < 2) {
      try {
        const ddg = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(sponsor)}`).then(r => r.text());
        const m = ddg.match(/<a[^>]+class="result__a"[^>]*href="(.*?)"/i);
        if (m && m[1]) {
          const link = decodeURIComponent(m[1]).replace(/^\/l\/?uddg=/, '');
          const html = await fetch(link, { redirect: 'follow' }).then(r => r.text());
          const more = extractFactsFromHtml(html);
          more.forEach(f => facts.add(f));
          sources.push({ type: 'search', url: link });
        }
      } catch (e) {}
    }

    const outFacts = Array.from(facts).slice(0, 3);
    return resp(200, { facts: outFacts, sources });
  } catch (err) {
    return resp(500, { error: 'Server error' });
  }
}

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  };
}

function normalizeSite(site) {
  try {
    const u = new URL(site.startsWith('http') ? site : `https://${site}`);
    return u.hostname + (u.pathname === '/' ? '' : u.pathname);
  } catch (e) {
    return site.replace(/^https?:\/\//, '');
  }
}

function extractFactsFromHtml(html) {
  const facts = new Set();
  const title = match1(html, /<title[^>]*>(.*?)<\/title>/i);
  const ogDesc = match1(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  const metaDesc = match1(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i);

  [title, ogDesc, metaDesc].forEach(s => {
    if (s) facts.add(cleanSentence(s));
  });

  // strip tags, scripts, styles
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

  // Try to capture neutral sentences mentioning 'founded', 'headquartered', etc.
  const founded = match1(text, /founded\s+in\s+(\d{4})/i);
  if (founded) facts.add(`founded in ${founded}`);

  const hq = match1(text, /headquartered\s+in\s+([A-Z][A-Za-z\s,]+)/i);
  if (hq) facts.add(`headquartered in ${hq.trim()}`);

  // grab first neutral-looking sentence
  const first = text.split('.').map(s => s.trim()).find(s => s.length > 40 && s.length < 200);
  if (first) facts.add(cleanSentence(first));

  // clean & filter
  return Array.from(facts)
    .map(cleanSentence)
    .filter(s => s && s.length < 180);
}

function match1(s, re) {
  const m = s && s.match(re);
  return m ? m[1].trim() : '';
}

function cleanSentence(s) {
  if (!s) return '';
  let t = s.replace(/\s+/g, ' ');
  t = t.replace(/[“”]/g, '"').replace(/[’]/g, "'").replace(/—/g, ' ');
  // remove promotional adjectives
  t = t.replace(/\b(leading|premier|renowned|world[- ]class|iconic|innovative|cutting-edge|award[- ]winning|best|ultimate|state-of-the-art)\b/gi, '');
  // trim leftover doubles
  t = t.replace(/\s{2,}/g, ' ').trim();
  return t;
}
