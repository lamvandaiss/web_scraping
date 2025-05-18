const axios = require("axios");
const cheerio = require("cheerio");
const { URL } = require("url");

const urls = [
  "https://truongvietanh.com/",
  "https://quocteachau.vn/",
  "https://hocbong.ntt.edu.vn/",
  "https://thicongnhasaigon.vn/",
  "https://kientrucxaydungtlt.com/",
  "https://saigoncentral.vn/",
  "https://www.centralcons.vn/",
];

// Hàm sleep sử dụng Promise để tạo delay
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

// Hàm kiểm tra robots.txt
async function isAllowed(url) {
  try {
    const domain = new URL(url).origin;
    const robotsUrl = `${domain}/robots.txt`;

    const res = await axios.get(robotsUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      },
    });

    const lines = res.data.split("\n");
    let userAgentAllowed = false;
    let currentUserAgent = null;

    for (const line of lines) {
      const clean = line.trim();
      if (clean.toLowerCase().startsWith("user-agent:")) {
        currentUserAgent = clean.split(":")[1].trim();
      } else if (
        clean.toLowerCase().startsWith("disallow:") &&
        currentUserAgent === "*"
      ) {
        const disallowPath = clean.split(":")[1].trim();
        if (disallowPath === "/" || disallowPath === "/*") {
          return false; // không được phép
        }
      } else if (
        clean.toLowerCase().startsWith("allow:") &&
        currentUserAgent === "*"
      ) {
        userAgentAllowed = true;
      }
    }

    return userAgentAllowed || true; // nếu không bị disallow
  } catch (err) {
    console.log(`⚠️ Không tìm thấy robots.txt tại ${url}, tiếp tục scrape.`);
    return true; // nếu không lấy được robots.txt thì vẫn tiếp tục
  }
}

async function scrape(url) {
  const allowed = await isAllowed(url);
  if (!allowed) {
    console.log(`🚫 Bị chặn theo robots.txt: ${url}`);
    return;
  }

  try {
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        Referer: "https://www.google.com/",
        "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });
    const info = extractData(data);
    console.log(`✅ ${url}`);
    console.log(info);
  } catch (err) {
    console.log(`❌ Lỗi khi truy cập ${url}`);
  }
}

(async () => {
  for (const url of urls) {
    await scrape(url);
    await sleep(Math.random() * 3000 + 1000); // Delay x giây giữa mỗi lần scrape
  }
})();
