const { chromium } = require('playwright');
const { execSync } = require('child_process');
const path = require('path');

const BASE = 'http://localhost:5555';
const SHOTS = path.join(__dirname, '..', 'screenshots');

// Sample small towns (weighted toward smaller places) for realistic routes.
const SCENARIOS = [
  {
    name: 'run1-basic',
    addresses: ['Ilkal, Karnataka, India', 'Chengala, Kerala, India', 'Singoli, Madhya Pradesh, India', 'Supaul, Bihar, India'],
    waitForResults: true,
  },
  {
    name: 'run2-eight',
    addresses: [
      'Ilkal, Karnataka, India', 'Chengala, Kerala, India', 'Singoli, Madhya Pradesh, India',
      'Supaul, Bihar, India', 'Budhma, Bihar, India', 'Varidhanam, Tamil Nadu, India',
      'Udala, Odisha, India', 'Reota, Uttar Pradesh, India',
    ],
    waitForResults: true,
  },
  {
    name: 'unreachable',
    addresses: ['Ilkal, Karnataka, India', 'Chengala, Kerala, India', 'North Sentinel Island, Andaman and Nicobar Islands, India'],
    waitForResults: false,
    expectUnreachable: true,
    zoomOut: true,
  },
  {
    name: 'ferries',
    // Messina Strait crossing (Sicily ↔ mainland) is a classic driveable ferry leg.
    addresses: ['Villa San Giovanni, Italy', 'Messina, Sicily, Italy', 'Palermo, Sicily, Italy', 'Reggio Calabria, Italy'],
    waitForResults: true,
    zoomOut: true,
  },
  {
    name: 'overview',
    addresses: ['Ilkal, Karnataka, India', 'Chengala, Kerala, India', 'Singoli, Madhya Pradesh, India', 'Supaul, Bihar, India', 'Udala, Odisha, India'],
    waitForResults: true,
  },
  {
    name: 'interim-live',
    addresses: ['Ilkal, Karnataka, India', 'Chengala, Kerala, India', 'Singoli, Madhya Pradesh, India', 'Supaul, Bihar, India', 'Udala, Odisha, India', 'Budhma, Bihar, India', 'Varidhanam, Tamil Nadu, India'],
    waitForResults: false,
    longSolve: true,
  },
];

function toJpg(pngPath, jpgPath) {
  execSync(`sips -s format jpeg -s formatOptions 85 "${pngPath}" --out "${jpgPath}"`, { stdio: 'inherit' });
}

async function fillAddresses(page, addresses) {
  const inputs = await page.locator('.addr-row input').all();
  for (let i = 0; i < addresses.length; i++) {
    await inputs[i].fill(addresses[i]);
  }
}

async function waitForResults(page) {
  await page.waitForSelector('#resultsSection:not(.hidden)', { timeout: 120000 });
  await page.waitForSelector('#segments tr', { timeout: 30000 });
}

// Zoom the Leaflet map out so all route points are clearly in view, and nudge
// it away from the right-hand panel. `tsp` is a global on the page.
async function zoomOutForCapture(page) {
  await page.evaluate(() => {
    if (typeof tsp === 'undefined') return;
    const c = tsp.getCenter();
    // nudge center left so the 380px panel doesn't hide the right edge
    tsp.setView([c.lat, c.lng - 0.04], Math.max(tsp.getZoom() - 1, 3), { animate: false });
  });
}

async function captureScenario(page, scenario) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#reset');
  await fillAddresses(page, scenario.addresses);

  if (scenario.longSolve) {
    // stretch the solve so we can screenshot mid-progress
    await page.selectOption('#population', { label: '2000' });
    await page.selectOption('#acc', { label: '5000' });
  }

  // resetAll sets classes; re-ensure valid after reset
  await page.click('#submit');

  const png = path.join(SHOTS, `tmp_${scenario.name}.png`);
  const jpg = path.join(SHOTS, `${scenario.name}.jpg`);

  if (scenario.expectUnreachable) {
    await page.waitForSelector('#unreachableNote:not(.hidden)', { timeout: 120000 });
    if (scenario.zoomOut) await zoomOutForCapture(page);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: png, fullPage: false });
  } else if (scenario.name === 'interim-live') {
    // screenshot mid-solve: wait until progress bar advances but not done
    await page.waitForSelector('#liveDist:not([hidden])', { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.screenshot({ path: png, fullPage: false });
  } else {
    await waitForResults(page);
    // let the map + table settle
    await page.waitForTimeout(2000);
    if (scenario.zoomOut) await zoomOutForCapture(page);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: png, fullPage: false });
  }
  toJpg(png, jpg);
  console.log('✓', scenario.name);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const only = process.argv.slice(2); // optional: scenario names to run
  for (const s of SCENARIOS) {
    if (only.length && !only.includes(s.name)) continue;
    try {
      await captureScenario(page, s);
    } catch (e) {
      console.error('✗', s.name, e.message);
    }
  }
  await browser.close();
  console.log('done');
})().catch(e => { console.error(e); process.exit(1); });
