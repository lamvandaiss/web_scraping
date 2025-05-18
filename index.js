const puppeteer = require("puppeteer");
const axios = require("axios");
const cheerio = require("cheerio");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractData(html) {
  const $ = cheerio.load(html);
  const text = $("body").text();

  const name = $("title").text().trim();
  const phoneMatch = text.match(/(0|\+84)[0-9 .\-]{8,13}/);
  const emailMatch = text.match(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
  );

  return {
    name,
    phone: phoneMatch ? phoneMatch[0] : "Không tìm thấy",
    email: emailMatch ? emailMatch[0] : "Không tìm thấy",
  };
}

async function scrapeWebsite(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      },
    });
    return extractData(res.data);
  } catch (err) {
    console.error(`❌ Lỗi truy cập ${url}`);
    return null;
  }
}

async function searchWithPuppeteer(keyword) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(
    `https://www.google.com/search?q=${encodeURIComponent(keyword)}`,
    {
      waitUntil: "domcontentloaded",
    }
  );

  // Chờ kết quả hiển thị
  await page.waitForSelector("a");

  // Lấy các URL từ kết quả tìm kiếm
  const links = await page.$$eval("a", (anchors) =>
    anchors
      .map((a) => a.href)
      .filter((href) => href.startsWith("http") && !href.includes("google.com"))
  );

  await browser.close();

  // Lọc ra 5 link đầu tiên hợp lệ
  const uniqueLinks = [...new Set(links)].slice(0, 10);
  return uniqueLinks;
}

(async () => {
  const keyword = "danh sách công ty xây dựng tại tphcm";
  const urls = await searchWithPuppeteer(keyword);
  console.log("🔎 Kết quả tìm kiếm:", urls);

  for (const url of urls) {
    const info = await scrapeWebsite(url);
    console.log("✅ Kết quả:", info);
    await sleep(Math.random() * 3000 + 1000); // delay x giây tránh bị chặn
  }
})();
