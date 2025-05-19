const puppeteer = require("puppeteer");
const axios = require("axios");
const cheerio = require("cheerio");
const urlModule = require("url");
const unwantedDomains = require("./unwanted-domains");
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

function exportToExcel(data, filename = "thong-tin.xlsx") {
  // Tạo folder nếu chưa có
  const outputFolder = path.join(__dirname, "output");
  if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder);
  }
  // Tên file và đường dẫn lưu
  const filepath = path.join(outputFolder, filename);

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Data");
  XLSX.writeFile(workbook, filepath);
}

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

  if (unwantedDomains.some((domain) => url.includes(domain))) return false;
  return trustedDomains.some((domain) => url.includes(domain));
}

// Trích xuất email, số điện thoại, tên, địa chỉ từ HTML
function extractData(html, url) {
  const $ = cheerio.load(html);
  const name = $("title").text().trim();

  // Bước 1: Lấy các số điện thoại từ <a href="tel:...">
  let phoneCandidates = [];
  $("a[href^='tel:']").each((i, el) => {
    const textPhone = $(el).text().trim();
    if (textPhone) phoneCandidates.push(textPhone);
    const hrefPhone = $(el).attr("href").replace(/^tel:/i, "").trim();
    if (hrefPhone) phoneCandidates.push(hrefPhone);
  });

  // Bước 2: Lấy số điện thoại từ các vùng text có khả năng
  if (phoneCandidates.length === 0) {
    let contactSection = $("footer").text().trim();

    if (!contactSection || contactSection.length < 10) {
      contactSection = $("header").text().trim();
    }

    if (!contactSection || contactSection.length < 10) {
      const possibleSections = $("body")
        .find("*")
        .filter((i, el) => {
          const id = $(el).attr("id") || "";
          const className = $(el).attr("class") || "";
          const txt = $(el).text().toLowerCase();
          return (
            id.toLowerCase().includes("contact") ||
            id.toLowerCase().includes("footer") ||
            id.toLowerCase().includes("info") ||
            className.toLowerCase().includes("contact") ||
            className.toLowerCase().includes("footer") ||
            className.toLowerCase().includes("info") ||
            txt.includes("liên hệ") ||
            txt.includes("contact") ||
            txt.includes("phone") ||
            txt.includes("điện thoại")
          );
        });

      if (possibleSections.length > 0) {
        contactSection = $(possibleSections[0]).text().trim();
      }
    }

    if (!contactSection || contactSection.length < 10) {
      contactSection = $("body").text().trim();
    }

    // Dùng regex bắt số điện thoại dạng có dấu chấm, dấu cách, dấu gạch ngang,...
    const phoneRegex = /(\+?84|0)([\s.\-()]*\d){8,12}/g;
    const phoneMatches = Array.from(
      contactSection.matchAll(phoneRegex),
      (m) => m[0]
    );

    phoneCandidates = phoneMatches;
  }

  // Chuẩn hóa số điện thoại
  const rawPhones = phoneCandidates.map(formatPhoneVN);
  const validPhones = [...new Set(rawPhones.filter((p) => p))];
  const phones = validPhones.slice(0, 2).map(formatReadablePhoneVN).join("; ");

  // Tìm email
  const contactText = $("footer").text() || $("body").text();
  const emailMatch = contactText.match(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
  );

  // Tìm địa chỉ
  const addressMatch = contactText.match(
    /(Địa chỉ|Trụ sở|Văn phòng|Address)[\s:\-–]{1,3}([^\n\r]{10,150})/i
  );

  const hostname = require("url").parse(url).hostname.replace("www.", "");

  return {
    website: hostname,
    name,
    phones: phones.length ? phones : "Không tìm thấy",
    // email: emailMatch ? emailMatch[0].trim() : "Không tìm thấy",
    address: addressMatch ? addressMatch[2].trim() : "Không tìm thấy",
  };
}

// Hàm chuẩn hóa số điện thoại (loại bỏ dấu chấm, khoảng trắng, chuyển +84 về 0...)
function formatPhoneVN(phone) {
  if (!phone) return "";
  phone = phone.replace(/[\s.\-\(\)]/g, "");
  if (/^00(?!84)/.test(phone)) return "";
  if (/^\+(\d{1,3})/.test(phone) && !phone.startsWith("+84")) return "";
  if (phone.startsWith("+84")) phone = "0" + phone.slice(3);
  else if (phone.startsWith("84")) phone = "0" + phone.slice(2);
  if (/^0\d{9,10}$/.test(phone)) return phone;
  return "";
}

// Hàm format số điện thoại để dễ đọc
function formatReadablePhoneVN(phone) {
  if (!phone) return "";
  if (phone.length === 10)
    return phone.replace(/(\d{3})(\d{3})(\d{4})/, "$1 $2 $3");
  if (phone.length === 11)
    return phone.replace(/(\d{4})(\d{3})(\d{4})/, "$1 $2 $3");
  return phone;
}

module.exports = { extractData };

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
// Set name for excel file
function getTimestampedFilename(prefix = "thong-tin") {
  const now = new Date();
  const formatted = now.toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${formatted}.xlsx`;
}

// Chuyển sang slug
function createSlug(str) {
  const change = str
    .normalize("NFD") // tách dấu
    .replace(/[\u0300-\u036f]/g, "") // xóa dấu
    .replace(/đ/g, "d") // chuyển đ -> d
    .replace(/Đ/g, "D");
  const slug = change.replace(/\s+/g, "-").toLowerCase();
  return slug;
}

// Chạy chương trình
(async () => {
  const keyword = "trường mầm non";
  const urls = await searchWithPuppeteer(keyword);
  console.log(`📦 Tổng số website chính thức: ${urls.length}`);
  console.log("🔎 Kết quả tìm kiếm (chính thức, không trùng):", urls);
  const output = [];
  let stt = 0;
  for (const url of urls) {
    const info = await scrapeWebsite(url);
    if (info && typeof info === "object" && Object.keys(info).length > 0) {
      stt++;
      // const infoWithSTT = { STT: stt, ...info };
      const infoWithSTT = {
        STT: stt,
        WEBSITE: info.website,
        PHONE: info.phones,
        NAME: info.name,
        ADDRESS: info.address,
      };
      output.push(infoWithSTT);

      console.log("✅ Thông tin thu thập được:", infoWithSTT);
    } else {
      console.warn("⚠️ Không lấy được thông tin hợp lệ từ:", url);
    }
    await sleep(Math.random() * 3000 + 1000); // delay tránh bị chặn
  }
  // Xuất file excel
  if (output.length === 0) {
    console.warn("❌ Không có dữ liệu hợp lệ để ghi vào Excel.");
  } else {
    const filename = getTimestampedFilename(createSlug(keyword));
    exportToExcel(output, filename);
    console.log("📤 Đã ghi file Excel:", filename);
  }
})();
