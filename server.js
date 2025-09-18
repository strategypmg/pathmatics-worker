import express from "express";
import puppeteer from "puppeteer";

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

    // First attempt
    await page.goto(link, { waitUntil: "domcontentloaded", timeout: 60000 });
    await loginIfNeeded(page);

    // Second attempt after login
    await page.goto(link, { waitUntil: "networkidle0", timeout: 60000 });

    // Fetch bytes with cookies
    const { bytes, filename, contentType } = await page.evaluate(async (url) => {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error("Download failed: " + r.status + " " + r.statusText + " :: " + body.slice(0,300));
      }
      const cd = r.headers.get("content-disposition") || "";
      const ct = r.headers.get("content-type") || "text/csv";
      const m = cd.match(/filename="?([^"]+)"?/i);
      const name = m ? m[1] : "pathmatics_report.csv";
      const ab = await r.arrayBuffer();
      const arr = Array.from(new Uint8Array(ab));
      return { bytes: arr, filename: name, contentType: ct };
    }, link);

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
