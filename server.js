import express from "express";
import puppeteer from "puppeteer";

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

const app = express();
app.use(express.json({ limit: "5mb" }));

const ST_EMAIL = process.env.ST_EMAIL || "YOUR_SENSOR_TOWER_EMAIL";
const ST_PASSWORD = process.env.ST_PASSWORD || "YOUR_SENSOR_TOWER_PASSWORD";

async function launchBrowser() {
  return puppeteer.launch({
    headless: "new",
    executablePath: puppeteer.executablePath(),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1366,768"
    ]
  });
}

async function loginIfNeeded(page) {
  const url = page.url();
  const looksLikeLogin =
    /login|sign[_-]?in|users\/sign_in/i.test(url) ||
    (await page.$('input[type="password"]'));
  if (!looksLikeLogin) return;

  const emailSel = 'input[type="email"], #email, input[name="email"], input#user_email';
  const passSel  = 'input[type="password"], #password, input[name="password"], input#user_password';
  const btnSel   = 'button[type="submit"], input[type="submit"], button:has-text("Sign in"), button:has-text("Log in")';

  await page.waitForSelector(emailSel, { timeout: 15000 });
  await page.type(emailSel, ST_EMAIL, { delay: 25 });
  await page.type(passSel, ST_PASSWORD, { delay: 25 });
  await Promise.all([
    page.click(btnSel),
    page.waitForNavigation({ waitUntil: "networkidle0", timeout: 30000 }).catch(() => {})
  ]);
}

async function ensureLoggedIn(page) {
  // Warm up main app to establish cookies and trigger login if required
  await page.setExtraHTTPHeaders({ Referer: "https://app.sensortower.com/" });
  await page.goto("https://app.sensortower.com/pathmatics/overview", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await loginIfNeeded(page);
  // After login, land once on overview to finalize session
  await page.goto("https://app.sensortower.com/pathmatics/overview", { waitUntil: "networkidle0", timeout: 60000 }).catch(() => {});
}

app.post("/run", async (req, res) => {
  const { link } = req.body || {};
  if (!link) return res.status(400).json({ error: "Missing link" });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/119 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

    // Ensure we have an authenticated session before hitting the API link
    await ensureLoggedIn(page);

    // Set a sensible Referer header for subsequent requests
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://app.sensortower.com/pathmatics/overview"
    });

    // Fetch bytes with session cookies; on 401/403 retry with Basic auth as ST sometimes requires it
    const { bytes, filename, contentType, status, triedBasic } = await page.evaluate(async (url, user, pass) => {
      async function doFetch(opts = {}) {
        const r = await fetch(url, Object.assign({
          credentials: "include",
          redirect: "follow",
          headers: {
            "Accept": "text/csv,application/octet-stream,*/*;q=0.8"
          }
        }, opts));
        const cd = r.headers.get("content-disposition") || "";
        const ct = r.headers.get("content-type") || "text/csv";
        const m = cd.match(/filename="?([^";]+)"?/i);
        const name = m ? m[1] : "pathmatics_report.csv";
        const ab = r.ok ? await r.arrayBuffer() : new ArrayBuffer(0);
        return { r, name, ct, ab };
      }

      let { r, name, ct, ab } = await doFetch();
      let usedBasic = false;

      if (!r.ok && (r.status === 401 || r.status === 403)) {
        // Try Basic auth header
        const token = btoa(`${user}:${pass}`);
        ({ r, name, ct, ab } = await doFetch({
          headers: {
            "Accept": "text/csv,application/octet-stream,*/*;q=0.8",
            "Authorization": `Basic ${token}`
          }
        }));
        usedBasic = true;
      }

      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`Download failed: ${r.status} ${r.statusText} :: ${body.slice(0,300)}`);
      }

      const arr = Array.from(new Uint8Array(ab));
      return { bytes: arr, filename: name, contentType: ct, status: r.status, triedBasic: usedBasic };
    }, link, ST_EMAIL, ST_PASSWORD);

    console.log(`download: ok status=${status} basic=${triedBasic} file=${filename}`);

    const buf = Buffer.from(bytes);
    res.setHeader("Content-Type", contentType || "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(buf);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err) });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`worker listening on :${PORT}`));
