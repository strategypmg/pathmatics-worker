const express = require("express");
const puppeteer = require("puppeteer");
const bodyParser = require("body-parser");
const { URL } = require("url");

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

const app = express();
app.use(bodyParser.json({ limit: "50mb" }));

const ST_EMAIL = process.env.ST_EMAIL;
const ST_PASSWORD = process.env.ST_PASSWORD;

async function loginIfNeeded(page) {
  // ... existing loginIfNeeded code ...
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
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9"
  });

  // Ensure we have an authenticated session before hitting the API link
  await ensureLoggedIn(page);

  // Set a sensible Referer header for subsequent requests
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://app.sensortower.com/pathmatics/overview"
  });

  const link = req.body.link;

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

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.status(status).send(Buffer.from(bytes));

  await browser.close();
});

app.listen(3000);
