const puppeteer = require("puppeteer");
const axios = require("axios");
const cheerio = require("cheerio");
const urlModule = require("url");

// Tạm dừng giữa các lần request để tránh bị chặn
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Kiểm tra xem URL có phải là domain chính thức không
function isOfficialDomain(url) {
  const trustedDomains = [
    ".edu.vn",
    ".vn",
    ".com",
    ".net",
    ".org",
    ".co",
    ".biz",
    ".gov.vn",
    ".com.vn",
    ".info",
    ".io",
  ];
  const unwantedDomains = [
    // Báo tổng hợp, giải trí, lá cải, không chính thống
    "baomoi.com",
    "vietbao.vn",
    "soha.vn",
    "kenh14.vn",
    "eva.vn",
    "docbao.vn",
    "2sao.vn",
    "tintuc.vn",
    "ngoisao.vn",
    "yeah1.com",
    "24h.com.vn",

    // Mạng xã hội, video, cache
    "facebook.com",
    "linkedin.com",
    "youtube.com",
    "tiktok.com",
    "webcache.googleusercontent.com",
    "google.com",
    "chat.zalo.me",

    // Trang tuyển dụng, việc làm, freelancer
    "vietnamworks.com",
    "careerlink.vn",
    "glints.com",
    "freelancervietnam.vn",
    "mywork.com.vn",
    "topcv.vn",
    "vieclam24h.vn",
    "timviecnhanh.com",
    "careerbuilder.vn",

    // Trang luật, tư vấn pháp luật
    "thuvienphapluat.vn",
    "luatvietan.vn",
    "luatvietnam.vn",
    "phapluatplus.vn",
    "phapluatxahoi.kinhtedothi.vn",

    // Trang vàng, directory, giới thiệu dịch vụ
    "yellowpages.vn",
    "trangvangvietnam.com",
    "trangvangtructuyen.vn",
    "toplist.vn",
    "top10tphcm.com",
    "maisonoffice.vn",
    "tuvanquangminh.com",
    "hbcg.vn",

    // Trang giáo dục, tài liệu, học tập, thi cử
    "123doc.net",
    "tuyensinhso.vn",
    "tailieu.vn",

    // Báo chính thống (có thể loại nếu bạn chỉ muốn nguồn tổ chức độc lập)
    "vnexpress.net",
    "dantri.com.vn",
    "laodong.vn",
    "vietnamnet.vn",
    "thanhnien.vn",
    "tuoitre.vn",
    "zingnews.vn",
    "nhandan.vn",
    "plo.vn",
    "suckhoedoisong.vn",
    "baogiaothong.vn",
    "congthuong.vn",
    "vov.vn",
    "vtv.vn",
    "cand.com.vn",
    "quochoi.vn",
    "toquoc.vn",
    "tienphong.vn",
    "baochinhphu.vn",
    "baocaovien.vn",
    "baodauthau.vn",
    "baodautu.vn",
    "thanhnienviet.vn",
    "nguoilaodong.vn",
    "viettimes.vn",
    "doanhnghiepvn.vn",
    "doanhnhan.vn",
    "giadinh.net.vn",

    // Báo ngành, tổ chức nhà nước
    "finance.vietstock.vn",
    "cafef.vn",
    "cafebiz.vn",
    "thitruongtaichinhtiente.vn",
    "moc.gov.vn",
    "baoquankhu7.vn",
    "vietnamreport.net.vn",
    "vnr500.com.vn",
    "lifestyle.znews.vn",
    "tripadvisor.com.vn",
    "ketoananpha.vn",
    // Other
    "masothue.com",
    "quocluat.vn",
    "vienquanlyxaydung.edu.vn",
    "homedy.com",
    "tuvanhuonglan.vn",
    "viettelconstruction.com.vn",
  ];

  if (unwantedDomains.some((domain) => url.includes(domain))) return false;
  return trustedDomains.some((domain) => url.includes(domain));
}

// Trích xuất email, số điện thoại, tên, địa chỉ từ HTML
function extractData(html, url) {
  const $ = cheerio.load(html);

  const name = $("title").text().trim();

  // Ưu tiên lấy thông tin từ <footer>
  let contactSection = $("footer").text();

  // Nếu không có nội dung footer, tìm phần có chứa từ khóa liên hệ / contact
  if (!contactSection || contactSection.length < 10) {
    contactSection = $("body")
      .find("*")
      .filter((i, el) => {
        const txt = $(el).text().toLowerCase();
        return txt.includes("liên hệ") || txt.includes("contact");
      })
      .first()
      .text();
  }

  // Lấy thông tin từ phần liên hệ đã chọn
  const phoneMatch = contactSection.match(/(0|\+84)[0-9 .\-]{8,13}/);
  const emailMatch = contactSection.match(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
  );
  const addressMatch = contactSection.match(
    /(Địa chỉ|Trụ sở|Văn phòng|Address)[\s:\-–]{1,3}([^\n]{10,100})/
  );

  const hostname = urlModule.parse(url).hostname.replace("www.", "");

  return {
    website: hostname,
    name,
    phone: phoneMatch ? phoneMatch[0].trim() : "Không tìm thấy",
    email: emailMatch ? emailMatch[0].trim() : "Không tìm thấy",
    address: addressMatch ? addressMatch[2].trim() : "Không tìm thấy",
  };
}

// ✨ Hàm mới: Tìm trang liên hệ trong website
async function findContactPage(homeUrl) {
  const possiblePaths = ["/lien-he", "/lienhe", "/contact", "/contact-us"];
  for (const path of possiblePaths) {
    const fullUrl = new URL(path, homeUrl).href;
    try {
      const res = await axios.get(fullUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        },
        timeout: 10000,
      });

      const html = res.data;
      const contactSection = cheerio.load(html)("body").text().toLowerCase();
      if (
        contactSection.includes("liên hệ") ||
        contactSection.includes("contact")
      ) {
        console.log(`👉 Tìm thấy trang liên hệ: ${fullUrl}`);
        return extractData(html, fullUrl);
      }
    } catch (err) {
      // không có gì, tiếp tục thử URL khác
    }
  }
  return null;
}

// 🔍 Truy cập website và chỉ lấy từ trang chủ hoặc trang liên hệ
async function scrapeWebsite(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      },
    });

    // Thử tìm trang liên hệ
    const contactData = await findContactPage(url);
    if (contactData) return contactData;

    // Nếu không có thì dùng trang chủ
    return extractData(res.data, url);
  } catch (err) {
    console.error(`❌ Lỗi truy cập ${url}`);
    return null;
  }
}

// Tìm kiếm trên Google và chỉ lấy một URL duy nhất cho mỗi domain
async function searchWithPuppeteer(keyword) {
  const browser = await puppeteer.launch({
    headless: "new",
    slowMo: 50,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
  );

  const allLinks = [];

  const maxPages = 10; // 🔁 số trang Google search bạn muốn duyệt (mỗi trang ~10 link)
  for (let i = 0; i < maxPages; i++) {
    const start = i * 10;
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(
      keyword
    )}&start=${start}`;

    try {
      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      await page.waitForSelector("a[href^='http']", { timeout: 10000 });

      const links = await page.$$eval("a[href^='http']", (anchors) =>
        anchors.map((a) => a.href)
      );

      allLinks.push(...links);
    } catch (err) {
      console.warn(
        `⚠️ Lỗi khi tải trang kết quả Google #${i + 1}:`,
        err.message
      );
    }

    await sleep(Math.random() * 2000 + 1000); // delay tránh bị chặn
  }

  await browser.close();

  // 👉 Lọc các link hợp lệ
  const officialLinks = allLinks.filter(isOfficialDomain);

  // 👉 Loại trùng domain
  const uniqueDomainMap = new Map();
  for (const link of officialLinks) {
    const hostname = urlModule.parse(link).hostname.replace("www.", "");
    if (!uniqueDomainMap.has(hostname)) {
      uniqueDomainMap.set(hostname, link);
    }
  }

  return Array.from(uniqueDomainMap.values());
}

// Chạy chương trình
(async () => {
  const keyword = "công ty xây dựng";
  const urls = await searchWithPuppeteer(keyword);
  console.log(`📦 Tổng số website chính thức: ${urls.length}`);
  console.log("🔎 Kết quả tìm kiếm (chính thức, không trùng):", urls);
  for (const url of urls) {
    const info = await scrapeWebsite(url);
    console.log("✅ Thông tin thu thập được:", info);
    await sleep(Math.random() * 3000 + 1000); // delay tránh bị chặn
  }
})();
