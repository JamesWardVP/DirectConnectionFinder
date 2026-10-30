// Tests the deployed website in a real browser (Chromium via Playwright),
// the way a visitor uses it. Run by the GitHub Action after each deploy.
//
// Usage: node scripts/test-live.mjs https://<user>.github.io/<repo>/
import fs from 'node:fs';
import { chromium } from 'playwright';

const url = process.argv[2];
if (!url) throw new Error('Pass the site URL');
fs.mkdirSync('screenshots', { recursive: true });

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? '✓' : '✗'} ${message}`);
  if (!ok) failures.push(message);
};

const browser = await chromium.launch();

async function desktop() {
  const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  // GitHub Pages can take a minute to serve a new deployment everywhere.
  let loaded = false;
  for (let attempt = 1; attempt <= 6 && !loaded; attempt++) {
    const res = await page.goto(url, { waitUntil: 'load' });
    if (res && res.ok()) {
      try {
        await page.waitForFunction(() => /covers/.test(document.querySelector('#data-status')?.textContent || ''), null, { timeout: 60000 });
        loaded = true;
      } catch { /* retry */ }
    }
    if (!loaded) await page.waitForTimeout(15000);
  }
  check(loaded, 'page opens and the timetable loads');
  if (!loaded) return;
  const status = await page.textContent('#data-status');
  console.log(`  status line: ${status}`);
  check(!(await page.isVisible('#demo-banner')), 'real timetable (no demo banner)');
  check(await page.isVisible('#showBeaten') && await page.isChecked('#showBeaten'), '"Show slower routes" is visible and on by default');

  // Search London Kings Cross → Edinburgh at 09:00 next Wednesday. Not
  // "tomorrow": weekend engineering works can close the East Coast line,
  // leaving no direct trains to Edinburgh, which is real and not a bug.
  const searchDate = await page.evaluate(() => {
    const d = new Date();
    do d.setDate(d.getDate() + 1); while (d.getDay() !== 3);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  });
  console.log(`  searching ${searchDate}`);
  await page.fill('#from-input', 'Kings Cross');
  await page.waitForSelector('#from-options li[role=option]');
  await page.keyboard.press('Enter');
  await page.fill('#to-input', 'Edinburgh');
  await page.waitForSelector('#to-options li[role=option]');
  await page.keyboard.press('Enter');
  // Radius slider: the + and − buttons move it and the label says what it covers.
  await page.click('[data-for="to-radius"][data-step="1"]');
  await page.click('[data-for="to-radius"][data-step="1"]');
  await page.waitForTimeout(400);
  const radiusText = await page.textContent('#to-radius-out');
  console.log(`  radius label: ${radiusText}`);
  check(await page.inputValue('#to-radius') === '2' && /Within 2 miles/.test(radiusText), 'radius + button and label work');
  await page.click('[data-for="to-radius"][data-step="-1"]');
  await page.click('[data-for="to-radius"][data-step="-1"]');
  check(/Edinburgh Waverley/.test(await page.inputValue('#to-input')), '"Edinburgh" suggests Edinburgh Waverley first');
  await page.fill('#date', searchDate);
  await page.fill('#time', '09:00');
  // Progress shows over the map while searching (record it: searches are quick).
  await page.evaluate(() => {
    window.busySeen = false;
    const el = document.querySelector('#busy');
    new MutationObserver(() => { if (!el.hidden) window.busySeen = true; }).observe(el, { attributes: true });
  });
  const t0 = Date.now();
  await page.click('.go');
  await page.waitForSelector('.journey', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(200);
  check(await page.evaluate(() => window.busySeen) && await page.isHidden('#busy'), 'search progress shows over the map, then goes away');
  const searchMs = Date.now() - t0;
  const cards = await page.$$eval('.journey .card', (els) => els.slice(0, 6).map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  console.log(`  search took ${searchMs} ms in the browser; first results:`);
  cards.forEach((c) => console.log(`    ${c}`));
  check(cards.length > 0, 'King\'s Cross → Edinburgh returns journeys');
  check(await page.locator('.group-head', { hasText: 'Direct' }).count() > 0, 'direct trains are listed first');
  const paths = await page.locator('.leaflet-overlay-pane path').count();
  check(paths > 0, `route lines are drawn on the map (${paths} shapes)`);
  await page.screenshot({ path: 'screenshots/1-results.png' });

  // Route lines: the tooltip follows the pointer and goes away when it leaves.
  const pt = await page.evaluate(() => {
    const p = [...document.querySelectorAll('path.route-hit')].at(-1);
    const m = p.getPointAtLength(p.getTotalLength() * 0.45), c = p.getScreenCTM();
    return { x: m.x * c.a + c.e, y: m.y * c.d + c.f };
  });
  await page.mouse.move(pt.x, pt.y, { steps: 4 });
  await page.waitForTimeout(300);
  const tipShown = await page.locator('.route-tip').count();
  await page.mouse.move(pt.x + 300, pt.y + 120);
  await page.waitForTimeout(500);
  const tipLeft = await page.locator('.route-tip').count();
  check(tipShown === 1 && tipLeft === 0, 'route tooltip shows on hover and disappears afterwards');

  // Clicking a route isolates it and opens the route panel.
  const routesBefore = await page.locator('path.route-hit').count();
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(600);
  const routeHits = await page.locator('path.route-hit').count();
  const panelText = (await page.textContent('#route-panel'))?.replace(/\s+/g, ' ').trim() || '';
  console.log(`  route panel: ${panelText.slice(0, 160)}`);
  check(await page.isVisible('#route-panel') && routeHits < routesBefore, 'clicking a route isolates it and shows its train times');
  await page.screenshot({ path: 'screenshots/1b-route-selected.png' });
  await page.click('#route-panel [data-act="close"]');
  await page.waitForTimeout(300);
  check(!(await page.isVisible('#route-panel')) && (await page.locator('path.route-hit').count()) === routesBefore, '"All routes" shows every route again');

  // Open the first journey: line diagram, fare and buy links.
  await page.click('.journey .card');
  await page.waitForSelector('.detail');
  const links = await page.$$eval('.detail .links a', (as) => as.map((a) => `${a.textContent.trim()} → ${a.href}`));
  links.forEach((l) => console.log(`    ${l}`));
  check(links.some((l) => l.includes('nationalrail.co.uk')), 'journey details have a National Rail link');
  check(await page.locator('.detail .stop.major').count() >= 2, 'journey details show the line diagram');
  const changeRow = await page.locator('.journey', { hasText: 'change at' }).first();
  if (await changeRow.count()) {
    // Open it, unless it is the journey already open.
    if (!(await changeRow.locator('.detail').count())) await changeRow.locator('.card').click();
    const text = await page.waitForSelector('.detail .transfer.change', { timeout: 5000 }).then((e) => e.innerText()).catch(() => '');
    console.log(`  ${text}`);
    check(/usually allow \d+ min/.test(text), 'journeys with a change say how long each station allows');
  }
  await page.screenshot({ path: 'screenshots/2-journey.png' });

  // Postcode search goes straight from the browser to postcodes.io.
  await page.fill('#from-input', 'YO1 7HH');
  const place = await page.waitForSelector('#from-options li[role=option] .opt-icon.place', { timeout: 20000 }).then(() => true).catch(() => false);
  check(place, 'postcode lookup finds a place');

  // "Direct from a station" via the station popup on the map.
  await page.fill('#from-input', 'Kings Cross');
  await page.waitForSelector('#from-options li[role=option]');
  await page.keyboard.press('Enter');
  await page.check('input[name=task][value=explore]', { force: true });
  await page.click('.go');
  const exploreOk = await page.waitForSelector('.ex-dest', { timeout: 60000 }).then(() => true).catch(() => false);
  const exSummary = exploreOk ? (await page.textContent('.summary')).trim() : '';
  console.log(`  ${exSummary}`);
  check(exploreOk && (await page.locator('.ex-dest', { hasText: 'Edinburgh Waverley' }).count()) > 0, 'direct destinations from Kings Cross include Edinburgh Waverley');
  if (exploreOk) {
    await page.locator('.ex-dest', { hasText: 'Edinburgh Waverley' }).first().locator('.ex-card').click();
    await page.waitForTimeout(500);
    check(await page.isVisible('#route-panel'), 'clicking a destination shows its departures');
    await page.screenshot({ path: 'screenshots/2b-direct-destinations.png' });
    await page.click('#route-panel [data-act=plan]');
    const planned = await page.waitForSelector('.journey .times', { timeout: 60000 }).then(() => true).catch(() => false);
    check(planned && /Edinburgh/.test(await page.inputValue('#to-input')), '"Plan this journey" opens journey results');
  }

  // "From a station" with one change allowed: Manchester is reached via a change.
  await page.check('input[name=task][value=explore]', { force: true });
  await page.check('input[name=reach][value="1"]', { force: true });
  const r0 = Date.now();
  await page.click('.go');
  const reached = await page.waitForFunction(() => /with up to 1 change/.test(document.querySelector('.summary')?.textContent || ''), null, { timeout: 90000 }).then(() => true).catch(() => false);
  const reachSummary = reached ? (await page.textContent('.summary')).trim() : '';
  console.log(`  ${reachSummary} (${Date.now() - r0} ms)`);
  check(reached && await page.locator('.group-head', { hasText: '1 change' }).count() > 0, '"From a station" with +1 change lists stations reached with a change');
  await page.fill('.ex-filter', 'Manchester Piccadilly');
  check(await page.locator('.ex-dest', { hasText: 'Manchester Piccadilly' }).count() > 0, 'Manchester Piccadilly is reachable from Kings Cross with a change');
  await page.screenshot({ path: 'screenshots/2c-from-station-changes.png' });
  await page.check('input[name=reach][value="0"]', { force: true });

  check(errors.length === 0, `no errors in the browser console${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await page.close();
}

async function mobile() {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.goto(url);
  await page.waitForFunction(() => /covers/.test(document.querySelector('#data-status')?.textContent || ''), null, { timeout: 60000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, 'phone layout fits the screen (no sideways scrolling)');
  await page.fill('#from-input', 'Paddington');
  await page.waitForSelector('#from-options li[role=option]');
  await page.keyboard.press('Enter');
  await page.fill('#to-input', 'Bristol Temple');
  await page.waitForSelector('#to-options li[role=option]');
  await page.keyboard.press('Enter');
  await page.tap('.go');
  const ok = await page.waitForSelector('.journey', { timeout: 60000 }).then(() => true).catch(() => false);
  check(ok, 'search works on a phone (Paddington → Bristol)');
  await page.screenshot({ path: 'screenshots/3-phone.png' });
  await page.close();
}

try {
  await desktop();
  await mobile();
} catch (err) {
  check(false, `test crashed: ${err.message}`);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nThe live site works.');
