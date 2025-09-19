import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.json({ limit: "5mb" }));

// --- Config ---
const ST_EMAIL = process.env.ST_EMAIL || "YOUR_SENSOR_TOWER_EMAIL";
const ST_PASSWORD = process.env.ST_PASSWORD || "YOUR_SENSOR_TOWER_PASSWORD";
const LOGIN_URL = process.env.LOGIN_URL || "https://app.sensortower.com/users/sign_in";
const OVERVIEW_URL = process.env.OVERVIEW_URL || "https://app.sensortower.com/pathmatics/overview";

async function launchBrowser() {
  return puppeteer.launch({
    headless: "new",
    executablePath: puppeteer.executablePath(),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1366,768",
      "--lang=en-US,en"
    ],
    defaultViewport: { width: 1366, height: 768 }
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function looksLikeLoginPage(page) {
  const url = page.url().toLowerCase();
  if (/users\/sign_in|login|sign[-_ ]?in/.test(url)) return true;
  try {
    const hasPwd = await page.$('input[type="password"]');
    return !!hasPwd;
  } catch { return false; }
}

async function doLogin(page) {
  console.log("[login] navigating to login page");
  await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 120000 });

  const emailSel = 'input[type="email"], #email, input[name="email"], input#user_email';
  const passSel  = 'input[type="password"], #password, input[name="password"], input#user_password';
  const btnSel   = 'button[type="submit"], input[type="submit"]';

  await page.waitForSelector(emailSel, { timeout: 30000 });
  await page.evaluate((eSel, pSel) => {
    const e = document.querySelector(eSel); if (e) e.value = "";
    const p = document.querySelector(pSel); if (p) p.value = "";
  }, emailSel, passSel);
  await page.type(emailSel, ST_EMAIL, { delay: 15 });
  await page.type(passSel, ST_PASSWORD, { delay: 15 });
  await Promise.all([
    page.click(btnSel),
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 120000 }).catch(() => {})
  ]);
  await delay(800);

  // land on overview to establish session
  await page.goto(OVERVIEW_URL, { waitUntil: "networkidle2", timeout: 120000 }).catch(() => {});

  const detectedEmail = await page.evaluate(() => {
    const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
    const html = document.documentElement?.innerHTML || "";
    const mail = document.querySelector('a[href^="mailto:"]');
    if (mail && mail.href) {
      const m1 = mail.href.match(EMAIL_RE); if (m1 && m1[0]) return m1[0];
    }
    const m = html.match(EMAIL_RE); return m && m[0] ? m[0] : "";
  });
  console.log("[login] detectedEmail", detectedEmail || "(none)");
}

async function ensureLoggedIn(page) {
  await page.setUserAgent(
    process.env.USER_AGENT ||
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": OVERVIEW_URL
  });

  // Touch overview; if we see login, run the login flow.
  await page.goto(OVERVIEW_URL, { waitUntil: "domcontentloaded", timeout: 120000 }).catch(() => {});
  if (await looksLikeLoginPage(page)) {
    await doLogin(page);
  }
}

async function fetchWithRetry(page, url, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await page.evaluate(async (downloadUrl) => {
        const r = await fetch(downloadUrl, { credentials: "include" });
        const status = r.status;
        const textSnap = status >= 400 ? (await r.text().catch(() => "")) : "";
        const cd = r.headers.get("content-disposition") || "";
        const ct = r.headers.get("content-type") || "application/octet-stream";
        const m = cd.match(/filename="?([^";]+)"?/i);
        const name = m ? m[1] : "pathmatics_report.csv";
        const ab = await r.arrayBuffer();
        const arr = Array.from(new Uint8Array(ab));
        return { ok: r.ok, status, name, ct, arr, textSnap };
      }, url);
    } catch (e) {
      lastErr = e;
    }
    // If we got here, retry after ensuring login again
    await ensureLoggedIn(page);
    await delay(500);
  }
  throw lastErr || new Error("fetchWithRetry: unknown error");
}

// --- Verify who is logged in ---
app.get('/whoami', async (req, res) => {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await ensureLoggedIn(page);
    const detectedEmail = await page.evaluate(() => {
      const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
      const html = document.documentElement?.innerHTML || "";
      const mail = document.querySelector('a[href^="mailto:"]');
      if (mail && mail.href) { const m1 = mail.href.match(EMAIL_RE); if (m1 && m1[0]) return m1[0]; }
      const m = html.match(EMAIL_RE); return m && m[0] ? m[0] : "";
    });
    console.log('[whoami] detectedEmail', detectedEmail || '(none)');
    res.json({ detectedEmail: detectedEmail || '' });
  } catch (e) {
    console.error('[whoami] error', e);
    res.status(500).json({ error: String(e) });
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
});

// --- Main download route ---
app.post("/run", async (req, res) => {
  const { link } = req.body || {};
  if (!link) return res.status(400).json({ error: "Missing link" });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await ensureLoggedIn(page);

    // Warm the link (sets any required cookies/redirects)
    await page.goto(link, { waitUntil: "domcontentloaded", timeout: 120000 }).catch(() => {});
    if (await looksLikeLoginPage(page)) {
      await doLogin(page);
      await page.goto(link, { waitUntil: "domcontentloaded", timeout: 120000 }).catch(() => {});
    }

    const resp = await fetchWithRetry(page, link, 2);
    if (!resp.ok) {
      console.log('[run] first fetch status', resp.status, 'snap:', (resp.textSnap||'').slice(0,150));
      // One more forced re-login then retry
      await doLogin(page);
      const resp2 = await fetchWithRetry(page, link, 1);
      if (!resp2.ok) {
        return res.status(500).json({ error: `Download failed: ${resp2.status} :: ${(resp2.textSnap||'').slice(0,200)}` });
      }
      const buf2 = Buffer.from(resp2.arr);
      res.setHeader("Content-Type", resp2.ct || "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${resp2.name}"`);
      return res.status(200).send(buf2);
    }

    const buf = Buffer.from(resp.arr);
    res.setHeader("Content-Type", resp.ct || "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${resp.name}"`);
    return res.status(200).send(buf);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err) });
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`worker listening on :${PORT}`));
