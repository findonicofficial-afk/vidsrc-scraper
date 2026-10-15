import express, { json } from "express";
import cors from "cors";
import { chromium } from "playwright";
import pLimit from "p-limit";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
export const OPENSUB_API_KEY = process.env.OPENSUB_API_KEY;
export const TMDB_API_KEY = process.env.TMDB_API_KEY;
export const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN;

export const headers = {
  Authorization: `Bearer ${TMDB_BEARER_TOKEN}`,
  "Content-Type": "application/json;charset=utf-8",
};

app.use(cors());
app.use(json());

// Sirf chalne wale 100% active domains
const PROVIDERS = [
  "https://vidsrc.sh",
  "https://vidsrc.net",
  "https://vidsrc.pm",
  "https://vidsrc2.ru"
];

export const LANGUAGE_NAMES = {
  en: "English",
};

export const COMMON_LANGUAGES = Object.keys(LANGUAGE_NAMES);

let browser;

// Anti-detection set kar ke global browser chalu karne ka function
async function initBrowser() {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });
}
initBrowser().catch(console.error);

const cache = new Map();
const limit = pLimit(2);

async function scrapeProvider(domain, url) {
  console.log(`\n[${domain}] Starting scrape for URL: ${url}`);

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 }
  });
  const page = await context.newPage();

  let hlsUrl = null;
  const subtitles = [];

  const isSubtitle = (url) => {
    return (
      /\.(vtt|srt)(\?.*)?\$/.test(url) ||
      url.includes(".vtt") ||
      url.includes(".srt")
    );
  };

  try {
    await page.route("**/*", (route) => {
      const reqUrl = route.request().url();

      if (!hlsUrl && reqUrl.includes(".m3u8")) {
        hlsUrl = reqUrl;
        console.log(`[${domain}] Found HLS URL: ${hlsUrl}`);
      }

      if (isSubtitle(reqUrl) && !subtitles.includes(reqUrl)) {
        subtitles.push(reqUrl);
        console.log(`[${domain}] (route) Found subtitle URL: ${reqUrl}`);
      }

      route.continue();
    });

    page.on("request", (request) => {
      const reqUrl = request.url();
      if (isSubtitle(reqUrl) && !subtitles.includes(reqUrl)) {
        subtitles.push(reqUrl);
        console.log(`[${domain}] (onRequest) Found subtitle: ${reqUrl}`);
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    console.log(`[${domain}] Page loaded`);

    const frameDiv = await page.waitForSelector("#the_frame", {
      timeout: 10000,
    });

    if (frameDiv) {
      const box = await frameDiv.boundingBox();

      if (box) {
        const clickX = box.x + box.width / 2;
        const clickY = box.y + box.height / 2;
        await page.mouse.move(clickX, clickY);
        await page.mouse.click(clickX, clickY);
      } else {
        await page.evaluate(() => {
          document.querySelector("#the_frame")?.click();
        });
      }

      await page.waitForTimeout(7000);

      if (!hlsUrl) {
        await page
          .waitForResponse((resp) => resp.url().includes(".m3u8"), {
            timeout: 5000,
          })
          .catch(() => {
            console.warn(`[${domain}] .m3u8 request not detected within 5s`);
          });
      }
    } else {
      throw new Error(`#the_frame div not found`);
    }

    await page.close();
    await context.close();

    if (!hlsUrl) throw new Error("HLS URL not found");

    return { hls_url: hlsUrl, subtitles, error: null };
  } catch (error) {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    console.error(`[${domain}] Error: ${error.message}`);
    return { hls_url: null, subtitles: [], error: error.message };
  }
}

app.get("/extract", async (req, res) => {
  const type = req.query.type || "movie";
  const tmdb_id = req.query.tmdb_id;
  const season = req.query.season ? parseInt(req.query.season) : undefined;
  const episode = req.query.episode ? parseInt(req.query.episode) : undefined;

  if (!tmdb_id) {
    return res.status(400).json({
      success: false,
      error: "tmdb_id query param is required",
      results: {},
    });
  }

  if (type === "tv" && (season == null || episode == null)) {
    return res.status(400).json({
      success: false,
      error: "season and episode query params are required for TV shows",
      results: {},
    });
  }

  const cacheKey = JSON.stringify(req.query);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 1000 * 60 * 15) {
    return res.json(cached.response);
  }

  // Naye working format ke mutabik clean URL structure
  const urls = PROVIDERS.reduce((acc, domain) => {
    acc[domain] =
      type === "tv"
        ? `${domain}/embed/tv/${tmdb_id}/${season}/${episode}`
        : `${domain}/embed/movie/${tmdb_id}`;
    return acc;
  }, {});

  try {
    const resultsArr = await Promise.all(
      Object.entries(urls).map(([domain, url]) =>
        limit(async () => {
          try {
            const result = await scrapeProvider(domain, url);
            return [domain, result];
          } catch (err) {
            return [
              domain,
              { hls_url: null, subtitles: [], error: err.message },
            ];
          }
        })
      )
    );

    const results = Object.fromEntries(resultsArr);
    const success = Object.values(results).some((r) => r.hls_url);
    const response = { success, results };

    cache.set(cacheKey, {
      timestamp: Date.now(),
      response,
    });

    res.json(response);
  } catch (err) {
    res.status(500).json({
      success: false,
      error: "Unexpected server error",
      results: {},
    });
  }
});

async function getIMDbIdFromTMDB(tmdb_id, type = "movie") {
  const url = `https://themoviedb.org{type}/${tmdb_id}/external_ids?api_key=${TMDB_API_KEY}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error("Failed to fetch IMDb ID from TMDB");
  const json = await response.json();
  return json.imdb_id || null;
}

async function searchSubtitles(imdb_id) {
  const res = await fetch(
    `https://opensubtitles.com{imdb_id}&per_page=100&page=1`,
    {
      headers: {
        "Api-Key": OPENSUB_API_KEY,
        "User-Agent": "Cinemi v1.0.0",
      },
    }
  );

  if (!res.ok) return [];
  const json = await res.json();
  if (!json.data || json.data.length === 0) return [];

  return json.data
    .filter(
      (item) =>
        item.attributes &&
        item.attributes.files &&
        item.attributes.files[0] &&
        item.attributes.files[0].file_id &&
        COMMON_LANGUAGES.includes(item.attributes.language)
    )
    .map((item) => {
      const file = item.attributes.files[0];
      const lang = item.attributes.language;
      return {
        language: lang,
        language_name: LANGUAGE_NAMES[lang] || lang,
        file_id: file.file_id,
      };
    });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
