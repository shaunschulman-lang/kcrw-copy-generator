
// Improved scrape function with stronger fallbacks
export async function handler(event, context) {
  try {
    const url = new URL(event.rawUrl || `http://x/?${event.rawQuery || ''}`);
    const sponsor = url.searchParams.get('sponsor') || '';
    const website = url.searchParams.get('website') || '';

    if (!sponsor) return resp(400, { error: 'Missing sponsor' });

    const sources = [];
    const factSet = new Set();

    // 1) Primary source: sponsor website (if provided)
    if (website) {
      const site = normalizeSite(website);
      try {
        const html = await fetch(`https://${site}`, { redirect: 'follow' }).then(r => r.text());
        const siteFacts = extractFactsFromHtml(html);
        siteFacts.forEach(f => factSet.add(f));
        sources.push({ type: 'website', url: `https://${site}` });
      } catch (e) {
        // ignore site fetch errors
      }
    }

    // 2) Wikipedia: get first 2-3 sentences for neutral descriptors
    try {
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(sponsor)}&format=json`;
      const sres = await fetch(searchUrl).then(r => r.json());
      if (sres?.query?.search?.[0]) {
        const pageid = sres.query.search[0].pageid;
        const pageUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts|pageprops|info&exintro=1&explaintext=1&inprop=url&pageids=${pageid}&format=json`;
        const pres = await fetch(pageUrl).then(r => r.json());
        const page = pres?.query?.pages?.[pageid];
        if (page) {
          const extract = (page.extract || '').replace(/\(.*?\)/g, '').replace(/—/g, ' ');
          const sentences = extract.split(/[\.\n]/).map(s => cleanSentence(s)).filter(Boolean);
          sentences.slice(0, 3).forEach(s => factSet.add(s));
          sources.push({ type: 'wikipedia', url: page.fullurl || `https://en.wikipedia.org/?curid=${pageid}` });

          // Wikidata (basic fields)
          const qid = page?.pageprops?.wikibase_item;
          if (qid) {
            try {
              const wdUrl = `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`;
              const w = await fetch(wdUrl).then(r => r.json());
              const entity = w?.entities?.[qid];
              if (entity?.claims) {
                const P571 = entity.claims.P571?.[0]?.mainsnak?.datavalue?.value?.time;
                if (P571) {
                  const year = (P571.match(/\d{4}/) || [])[0];
                  if (year) factSet.add(`founded in ${year}`);
                }
                const P159 = entity.claims.P159?.[0]?.mainsnak?.datavalue?.value;
                if (P159?.text) factSet.add(`headquartered in ${P159.text}`);
                const P452 = entity.claims.P452?.[0]?.mainsnak?.datavalue?.value;
                if (P452?.text) factSet.add(`${(P452.text || '').toLowerCase()} sector`.trim());
              }
            } catch {}
          }
        }
      }
    } catch {}

    // 3) Search fallback: first organic result, parse meta/title
    if (factSet.size < 3) {
      try {
        const ddg = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(sponsor)}`).then(r => r.text());
        const m = ddg.match(/<a[^>]+class=\"result__a\"[^>]*href=\"(.*?)\"/i);
        if (m && m[1]) {
          const link = decodeURIComponent(m[1]).replace(/^\/l\/?uddg=/, '');
          const html = await fetch(link, { redirect: 'follow' }).then(r => r.text());
          extractFactsFromHtml(html).forEach(f => factSet.add(f));
          sources.push({ type: 'search', url: link });
        }
      } catch {}
    }

    // 4) Last-resort synth facts to guarantee output
    const normalized = normalizeSite(website);
    if (factSet.size === 0 && sponsor) {
      factSet.add(`${sponsor} is referenced on public web sources`);
    }
    if (normalized) {
      factSet.add(`information available at ${normalized}`);
    }

    const facts = Array.from(factSet)
      .map(cleanSentence)
      .filter(Boolean)
      .slice(0, 5);

    return resp(200, { facts, sources });
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
  if (!site) return '';
  try {
    const u = new URL(site.startsWith('http') ? site : `https://${site}`);
    return u.hostname + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return site.replace(/^https?:\/\//, '');
  }
}

function extractFactsFromHtml(html) {
  const facts = new Set();
  // titles, meta
  const title = match1(html, /<title[^>]*>(.*?)<\/title>/i);
  const ogDesc = match1(html, /<meta[^>]+property=[\"']og:description[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>/i);
  const metaDesc = match1(html, /<meta[^>]+name=[\"']description[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>/i);
  [title, ogDesc, metaDesc].forEach(s => s && facts.add(cleanSentence(s)));

  // text body
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

  const founded = match1(text, /founded\s+in\s+(\d{4})/i);
  if (founded) facts.add(`founded in ${founded}`);

  const hq = match1(text, /headquartered\s+in\s+([A-Z][A-Za-z\s,]+)/i);
  if (hq) facts.add(`headquartered in ${hq.trim()}`);

  // first neutral-ish sentence
  const first = text.split('.').map(s => s.trim()).find(s => s.length > 40 && s.length < 200);
  if (first) facts.add(cleanSentence(first));

  return Array.from(facts).map(cleanSentence).filter(s => s && s.length < 180);
}

function match1(s, re) {
  const m = s && s.match(re);
  return m ? m[1].trim() : '';
}

function cleanSentence(s) {
  if (!s) return '';
  let t = s.replace(/\s+/g, ' ');
  t = t.replace(/[“”]/g, '"').replace(/[’]/g, "'").replace(/—/g, ' ');
  t = t.replace(/\(.*?\)/g, '').replace(/\s{2,}/g, ' ').trim();
  // remove promotional adjectives
  t = t.replace(/\b(leading|premier|renowned|world[- ]class|iconic|innovative|cutting-edge|award[- ]winning|best|ultimate|state-of-the-art|top[- ]tier)\b/gi, '');
  return t.trim();
}
