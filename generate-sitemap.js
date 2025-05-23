const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const xml2js = require("xml2js");
const { MongoClient } = require("mongodb");
const robotsParser = require("robots-parser");
const { URL } = require("url");

// --- Cấu hình chung ---
const startUrl = "https://mayphatdientanthanhtai.com/"; // 🔁 Thay bằng website cần crawl
const outputDir = "output"; // Thư mục lưu trữ kết quả crawl
const maxArticlesToCrawlForSitemap = 500; // Số lượng bài viết tối đa cần crawl để TẠO SITEMAP MỚI
const maxArticlesToAnalyze = 1000; // Số lượng bài viết tối đa cần PHÂN TÍCH SEO từ sitemap MỚI
const mongoUri = "mongodb://localhost:27017"; // URI kết nối MongoDB
const dbName = "seo_crawler"; // Tên database MongoDB

// --- Biến theo dõi trạng thái và thống kê (sẽ được đặt lại cho các giai đoạn) ---
let visited = new Set();
let toVisit = new Set();
const crawledUrlsForSitemap = new Set(); // Các URL hợp lệ đã crawl để tạo sitemap
let seoReports = []; // Các cảnh báo SEO riêng lẻ cho từng trang

// Thống kê cho báo cáo tổng thể
let totalMissingAltImages = 0;
let total404Pages = 0;
let pagesWith404 = []; // Danh sách các trang lỗi 404
let pagesWithMissingAlt = []; // Danh sách các trang có ảnh thiếu alt { urlTrang, images: [imgUrl, ...] }

// Lấy domain chính để tạo thư mục con trong output
function getDomainFolder(url) {
  const hostname = new URL(url).hostname.replace(/^www\./, "");
  return path.join(outputDir, hostname);
}

// Tạo thư mục output nếu chưa có
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

// Tạo thư mục domain nếu chưa có
const domainFolder = getDomainFolder(startUrl);
if (!fs.existsSync(domainFolder))
  fs.mkdirSync(domainFolder, { recursive: true });

// --- Hàm tiện ích ---
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Kiểm tra xem URL có phải là URL bài viết không (loại bỏ category, files tĩnh)
function isArticleURL(url) {
  try {
    const urlObj = new URL(url);
    // Bỏ qua các file tĩnh và các đường dẫn /category, /tag
    if (
      urlObj.pathname.match(
        /\.(jpg|jpeg|png|gif|webp|svg|css|js|pdf|xml|txt)$/i
      ) ||
      urlObj.pathname.includes("/category") ||
      urlObj.pathname.includes("/tag")
    ) {
      return false;
    }
    // Đảm bảo là cùng domain và không phải chỉ là root (ví dụ: http://example.com/)
    return (
      urlObj.hostname === new URL(startUrl).hostname &&
      urlObj.pathname.length > 1
    );
  } catch (e) {
    console.warn(`Lỗi khi kiểm tra URL: ${url} - ${e.message}`);
    return false;
  }
}

// --- Chức năng chính: Xử lý Sitemap ---
async function getArticleURLsFromSitemap(sitemapUrl) {
  try {
    console.log(`Đang cố gắng tải sitemap từ: ${sitemapUrl}`);
    const res = await fetch(sitemapUrl, { timeout: 15000 }); // Tăng timeout
    if (!res.ok) {
      throw new Error(`Không thể tải sitemap, trạng thái: ${res.status}`);
    }
    const xml = await res.text();
    const parsed = await new xml2js.Parser().parseStringPromise(xml);

    const urls = [];
    // Xử lý urlset
    if (parsed.urlset && parsed.urlset.url) {
      urls.push(...parsed.urlset.url.map((u) => u.loc[0]));
    }
    // Xử lý sitemapindex (sitemap của các sitemap con)
    if (parsed.sitemapindex && parsed.sitemapindex.sitemap) {
      console.log("Tìm thấy sitemap index. Đang đọc các sitemap con...");
      for (const sitemapEntry of parsed.sitemapindex.sitemap) {
        const subSitemapUrl = sitemapEntry.loc[0];
        try {
          const subRes = await fetch(subSitemapUrl, { timeout: 15000 });
          if (!subRes.ok) {
            console.warn(
              `⚠️ Không thể tải sitemap con: ${subSitemapUrl}, trạng thái: ${subRes.status}`
            );
            continue;
          }
          const subXml = await subRes.text();
          const subParsed = await new xml2js.Parser().parseStringPromise(
            subXml
          );
          if (subParsed.urlset && subParsed.urlset.url) {
            urls.push(...subParsed.urlset.url.map((u) => u.loc[0]));
          }
        } catch (subErr) {
          console.warn(
            `⚠️ Lỗi khi xử lý sitemap con ${subSitemapUrl}: ${subErr.message}`
          );
        }
      }
    }
    const filteredUrls = urls.filter(isArticleURL);
    console.log(
      `Đã tìm thấy ${filteredUrls.length} URL từ sitemap (sau khi lọc).`
    );
    return filteredUrls;
  } catch (err) {
    console.warn(
      `⚠️ Không tải hoặc phân tích được sitemap từ ${sitemapUrl}: ${err.message}`
    );
    return [];
  }
}

async function generateSitemap(
  urls,
  outputPath,
  filename = "sitemap_generated.xml"
) {
  if (urls.size === 0) {
    console.log("Không có URL nào được crawl thành công để tạo sitemap.");
    return null;
  }

  let urlEntries = "";
  const now = new Date().toISOString().split("T")[0]; // Định dạng YYYY-MM-DD
  for (const url of urls) {
    urlEntries += `
        <url>
            <loc>${url}</loc>
            <lastmod>${now}</lastmod>
            <changefreq>daily</changefreq>
            <priority>0.7</priority>
        </url>`;
  }

  const sitemapContent = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    ${urlEntries}
</urlset>`;

  const sitemapFilePath = path.join(outputPath, filename);
  fs.writeFileSync(sitemapFilePath, sitemapContent.trim(), "utf-8"); // .trim() để loại bỏ dòng trắng thừa
  console.log(`📄 Đã tạo sitemap tùy chỉnh: ${sitemapFilePath}`);
  return sitemapFilePath;
}

// --- Chức năng Robots.txt ---
const robotsTxtCache = new Map(); // Cache robots.txt để tránh tải nhiều lần
async function isAllowedByRobots(url) {
  try {
    const urlObj = new URL(url);
    const robotsUrl = new URL("/robots.txt", urlObj.origin).href;

    if (!robotsTxtCache.has(robotsUrl)) {
      console.log(`Đang tải robots.txt từ: ${robotsUrl}`);
      const res = await fetch(robotsUrl, { timeout: 8000 });
      if (!res.ok) {
        console.warn(
          `Không tải được robots.txt từ ${robotsUrl}, trạng thái: ${res.status}. Coi như được phép.`
        );
        robotsTxtCache.set(robotsUrl, null); // Lưu null để biết đã thử tải
        return true;
      }
      const txt = await res.text();
      robotsTxtCache.set(robotsUrl, robotsParser(robotsUrl, txt));
    }

    const robots = robotsTxtCache.get(robotsUrl);
    if (!robots) return true; // Nếu không tải được robots.txt

    // Kiểm tra cho các user-agent phổ biến hoặc user-agent tùy chỉnh
    const allowed =
      robots.isAllowed(url, "Googlebot") ||
      robots.isAllowed(url, "MyFriendlyBot");
    return allowed;
  } catch (e) {
    console.warn(
      `⚠️ Lỗi khi kiểm tra robots.txt cho ${url}: ${e.message}. Coi như được phép.`
    );
    return true;
  }
}

// --- Chức năng tải ảnh ---
async function downloadImage(url, folder) {
  try {
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) throw new Error(`Không tải được ảnh, status: ${res.status}`);

    // Đảm bảo thư mục tồn tại
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

    const buffer = await res.buffer();
    const urlObj = new URL(url);
    // Lấy tên file từ pathname, bỏ các query params
    let filename = path.basename(urlObj.pathname).split("?")[0];
    // Đảm bảo filename không rỗng và có đuôi mở rộng
    if (!filename || !filename.includes(".")) {
      filename = `image_${Date.now()}.${
        res.headers.get("content-type")?.split("/")[1] || "jpg"
      }`;
    }
    const filepath = path.join(folder, filename);
    fs.writeFileSync(filepath, buffer);
    return filename;
  } catch (e) {
    console.warn(`⚠️ Tải ảnh thất bại (${e.message}): ${url}`);
    return null;
  }
}

// --- Chức năng Crawl trang và phân tích SEO ---
async function crawlPage(
  page,
  url,
  articlesCollection,
  saveToDb = true,
  collectSeoInfo = true
) {
  const pageSeoWarnings = []; // Cảnh báo SEO riêng cho trang này
  await page.setUserAgent(
    "MyFriendlyBot/1.0 (+https://yourdomain.com/bot-info)" // Thay đổi tùy ý
  );

  let status = 200; // Mặc định là 200 OK
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    }); // Tăng timeout
    status = response ? response.status() : 200; // Lấy trạng thái từ response, nếu có
    await delay(Math.random() * 2000 + 1000); // Thêm độ trễ ngẫu nhiên

    if (status === 404) {
      if (collectSeoInfo) {
        pageSeoWarnings.push("❌ Trang trả về 404 (liên kết hỏng)");
        total404Pages++;
        pagesWith404.push(url);
      }
    } else {
      // Luôn thêm vào danh sách tạo sitemap nếu trang không phải 404 và là URL bài viết
      if (isArticleURL(url)) {
        crawledUrlsForSitemap.add(url);
      }
    }

    if (collectSeoInfo && status !== 404) {
      // Chỉ phân tích SEO nếu trang không phải 404
      const metadata = await page.evaluate(() => {
        const get = (sel) => document.querySelector(sel)?.content || "";
        return {
          title: document.title,
          h1: document.querySelector("h1")?.innerText || "",
          description: get('meta[name="description"]'),
          canonical:
            document.querySelector("link[rel='canonical']")?.href || "",
          lang: document.documentElement.lang || "",
          viewport: get('meta[name="viewport"]'),
        };
      });

      // Kiểm tra SEO cơ bản
      if (!metadata.h1) pageSeoWarnings.push("⚠️ Thiếu thẻ H1");
      if (
        !metadata.title ||
        metadata.title.length < 10 ||
        metadata.title.length > 70
      ) {
        pageSeoWarnings.push(
          `⚠️ Tiêu đề (${metadata.title.length} ký tự) không tối ưu (nên từ 10-70 ký tự)`
        );
      }
      if (
        !metadata.description ||
        metadata.description.length < 50 ||
        metadata.description.length > 160
      ) {
        pageSeoWarnings.push(
          `⚠️ Mô tả (${metadata.description.length} ký tự) không tối ưu (nên từ 50-160 ký tự)`
        );
      }
      if (!metadata.canonical || metadata.canonical.trim() !== url.trim()) {
        pageSeoWarnings.push(
          `⚠️ Thiếu hoặc Canonical URL không khớp: ${
            metadata.canonical || "Không có"
          }`
        );
      }
      const isResponsive = metadata.viewport.includes("width=device-width");
      if (!isResponsive)
        pageSeoWarnings.push("⚠️ Thiếu thẻ viewport responsive");

      // Tìm ảnh thiếu alt
      const imgsMissingAlt = await page.$$eval("img", (imgs) =>
        imgs
          .filter((img) => !img.alt || img.alt.trim() === "")
          .map((img) => img.src)
      );

      if (imgsMissingAlt.length > 0) {
        pageSeoWarnings.push(
          `⚠️ Có ${imgsMissingAlt.length} ảnh thiếu thuộc tính alt`
        );
        totalMissingAltImages += imgsMissingAlt.length;
        pagesWithMissingAlt.push({ urlTrang: url, images: imgsMissingAlt });
      }

      // Lấy nội dung bài viết và giá (nếu có)
      const content = await page
        .$eval("article, main, body", (el) => el.innerText) // Tìm thẻ article, main hoặc body
        .catch(() => "");
      const price = await page
        .$eval(".price, [itemprop='price']", (el) => el.innerText) // Thêm itemprop
        .catch(() => "");

      // Tạo thư mục riêng cho trang và tải ảnh (chỉ khi thu thập SEO info)
      // Lấy một phần của URL làm tên thư mục, đảm bảo hợp lệ
      const urlPathSegment = new URL(url).pathname
        .replace(/\/+$/, "") // Loại bỏ dấu / ở cuối
        .replace(/^\//, ""); // Loại bỏ dấu / ở đầu
      const pageFolderName = urlPathSegment
        ? urlPathSegment.replace(/[^a-zA-Z0-9_-]+/g, "_").substring(0, 50) // Giới hạn độ dài
        : "root_page";
      const pageFolder = path.join(domainFolder, pageFolderName);

      const downloadedImgs = [];
      // Tải tối đa 3 ảnh (có thể cấu hình)
      const images = await page.$$eval("img", (imgs) =>
        imgs.map((img) => img.src)
      );
      for (const src of images.slice(0, 3)) {
        const filename = await downloadImage(src, pageFolder);
        if (filename) downloadedImgs.push(filename);
      }

      if (pageSeoWarnings.length > 0) {
        seoReports.push(`🔗 URL: ${url}\n${pageSeoWarnings.join("\n")}\n`);
      }

      if (saveToDb) {
        await articlesCollection.insertOne({
          url,
          metadata,
          price,
          content: content.substring(0, 5000), // Giới hạn độ dài content lưu vào DB
          images: downloadedImgs,
          seoWarnings: pageSeoWarnings,
          crawledAt: new Date(),
        });
      }
    }
    console.log(`✅ Đã xử lý (Trạng thái: ${status}): ${url}`);
  } catch (err) {
    console.warn(`❌ Lỗi khi xử lý trang (${err.message}): ${url}`);
    if (collectSeoInfo) {
      // Ghi nhận lỗi nếu đang ở giai đoạn phân tích SEO
      pageSeoWarnings.push(`❌ Lỗi truy cập/phân tích trang: ${err.message}`);
      seoReports.push(`🔗 URL: ${url}\n${pageSeoWarnings.join("\n")}\n`);
    }
  }
}

// --- Hàm chính để chạy chương trình ---
async function main(startUrl) {
  let browser;
  let client;
  try {
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    client = await MongoClient.connect(mongoUri);
    const db = client.db(dbName);
    const articlesCollection = db.collection("articles");
    const seoSummaryCollection = db.collection("seo_summary_reports");

    // Xóa dữ liệu cũ trong DB trước khi bắt đầu (tùy chọn)
    await articlesCollection.deleteMany({});
    await seoSummaryCollection.deleteMany({});
    console.log("Đã xóa dữ liệu cũ trong MongoDB.");

    // --- GIAI ĐOẠN 0: TẢI SITEMAP CŨ (CHỈ ĐỂ THAM KHẢO) ---
    console.log(
      "\n--- GIAI ĐOẠN 0: TẢI SITEMAP HIỆN CÓ (CHỈ ĐỂ THAM KHẢO) ---"
    );
    const sitemapCurrentUrl = new URL("/sitemap.xml", startUrl).href;
    const urlsFromOldSitemap = await getArticleURLsFromSitemap(
      sitemapCurrentUrl
    );
    if (urlsFromOldSitemap.length > 0) {
      console.log(
        `✅ Đã tải và đọc ${urlsFromOldSitemap.length} URL từ sitemap hiện có của website.`
      );
    } else {
      console.log(
        "⚠️ Không tìm thấy sitemap hiện có hoặc không có URL nào trong đó."
      );
    }

    // --- GIAI ĐOẠN 1: CRAWL ĐỂ TẠO SITEMAP MỚI (BẮT ĐẦU TỪ START_URL) ---
    console.log("\n--- GIAI ĐOẠN 1: CRAWL ĐỂ TẠO SITEMAP MỚI ---");

    visited = new Set();
    toVisit = new Set();
    crawledUrlsForSitemap.clear(); // Xóa dữ liệu cũ

    // LUÔN BẮT ĐẦU CRAWL TỪ START_URL để tạo sitemap mới
    console.log(`Bắt đầu crawl từ URL gốc (${startUrl}) để tạo sitemap mới.`);
    toVisit.add(startUrl);

    let crawledCountForSitemap = 0;
    const processedUrlsDuringSitemapGen = new Set(); // Để theo dõi các URL đã xử lý trong giai đoạn này
    while (
      toVisit.size > 0 &&
      crawledCountForSitemap < maxArticlesToCrawlForSitemap
    ) {
      const url = toVisit.values().next().value;
      toVisit.delete(url);

      if (processedUrlsDuringSitemapGen.has(url)) {
        // Kiểm tra đã xử lý trong giai đoạn này chưa
        console.log(`⏩ [Sitemap Gen] Bỏ qua (đã xử lý): ${url}`);
        continue;
      }

      if (!(await isAllowedByRobots(url))) {
        console.log(
          `⛔ [Sitemap Gen] Bỏ qua (robots.txt không cho phép): ${url}`
        );
        processedUrlsDuringSitemapGen.add(url);
        continue;
      }

      // Trong giai đoạn này, chúng ta chỉ cần crawl để biết URL có tồn tại và thu thập cho sitemap
      // Không cần lưu vào DB hay thu thập chi tiết SEO
      await crawlPage(page, url, articlesCollection, false, false);
      processedUrlsDuringSitemapGen.add(url); // Đánh dấu đã xử lý
      crawledCountForSitemap++;

      // Tìm thêm các liên kết nội bộ để crawl cho sitemap
      try {
        const newLinks = await page.$$eval(
          "a[href]",
          (anchors, origin) =>
            anchors
              .map((a) => a.href)
              .filter(
                (href) =>
                  href.startsWith(origin) && // Chỉ liên kết nội bộ
                  !href.includes("#") && // Bỏ qua anchor links
                  !href.match(
                    /\.(jpg|jpeg|png|gif|webp|svg|css|js|pdf|xml|txt)$/i
                  ) // Bỏ qua file tĩnh
              ),
          new URL(url).origin
        ); // Truyền origin vào evaluate context

        newLinks.forEach((link) => {
          // Thêm vào toVisit nếu chưa được xử lý và là URL bài viết
          if (
            !processedUrlsDuringSitemapGen.has(link) &&
            isArticleURL(link) &&
            !toVisit.has(link)
          ) {
            toVisit.add(link);
          }
        });
      } catch (e) {
        console.warn(
          `Lỗi khi tìm liên kết nội bộ trong giai đoạn sitemap gen: ${e.message}`
        );
      }
    }

    console.log(
      `\nTổng số URL đã crawl thành công để tạo sitemap mới: ${crawledUrlsForSitemap.size}`
    );
    const generatedSitemapPath = await generateSitemap(
      crawledUrlsForSitemap,
      domainFolder,
      "sitemap_new_generated.xml"
    );

    if (!generatedSitemapPath) {
      console.error("Không thể tạo sitemap mới. Kết thúc chương trình.");
      return;
    }

    // --- GIAI ĐOẠN 2: PHÂN TÍCH SEO TRÊN SITEMAP MỚI ĐƯỢC TẠO ---
    console.log(
      "\n--- GIAI ĐOẠN 2: PHÂN TÍCH SEO TRÊN SITEMAP MỚI ĐƯỢC TẠO ---"
    );

    // Đặt lại các biến trạng thái và thống kê cho giai đoạn phân tích SEO
    visited = new Set(); // visited cho giai đoạn này
    toVisit = new Set(); // toVisit cho giai đoạn này
    seoReports = [];
    totalMissingAltImages = 0;
    total404Pages = 0;
    pagesWith404 = [];
    pagesWithMissingAlt = [];

    // Lấy các URL từ sitemap MỚI để thực hiện phân tích SEO
    const urlsFromNewSitemap = await getArticleURLsFromSitemap(
      generatedSitemapPath
    );
    if (urlsFromNewSitemap.length === 0) {
      console.error(
        "Không có URL nào trong sitemap mới để phân tích SEO. Kết thúc chương trình."
      );
      return;
    }
    // Giới hạn số lượng URL phân tích SEO theo cấu hình
    const urlsToAnalyze = urlsFromNewSitemap.slice(0, maxArticlesToAnalyze);
    urlsToAnalyze.forEach((url) => toVisit.add(url));
    console.log(
      `Bắt đầu phân tích SEO trên ${urlsToAnalyze.length} URL từ sitemap mới.`
    );

    let analyzedCount = 0;
    while (toVisit.size > 0 && analyzedCount < maxArticlesToAnalyze) {
      const url = toVisit.values().next().value;
      toVisit.delete(url);

      if (visited.has(url)) {
        console.log(`⏩ [SEO Analyze] Bỏ qua (đã phân tích): ${url}`);
        continue;
      }
      if (!(await isAllowedByRobots(url))) {
        console.log(
          `⛔ [SEO Analyze] Bỏ qua (robots.txt không cho phép): ${url}`
        );
        visited.add(url); // Đánh dấu là đã xử lý (bỏ qua)
        continue;
      }

      // Trong giai đoạn này, chúng ta lưu vào DB và thu thập thông tin SEO chi tiết
      await crawlPage(page, url, articlesCollection, true, true);
      visited.add(url);
      analyzedCount++;
    }

    console.log("\n--- HOÀN TẤT QUÁ TRÌNH PHÂN TÍCH SEO ---");

    // --- Tạo báo cáo tổng hợp ---
    let summaryReport = `\n=== BÁO CÁO SEO TỔNG KẾT (${new Date().toLocaleString()}) ===\n`;
    summaryReport += `Tên miền: ${new URL(startUrl).hostname}\n`;
    summaryReport += `Sitemap được sử dụng để phân tích: ${path.basename(
      generatedSitemapPath
    )}\n`;
    summaryReport += `Tổng số URL đã phân tích: ${visited.size}\n`;
    summaryReport += `Tổng số ảnh thiếu thuộc tính alt: ${totalMissingAltImages}\n`;
    summaryReport += `Tổng số trang trả về lỗi 404: ${total404Pages}\n\n`;

    if (pagesWith404.length > 0) {
      summaryReport += "--- DANH SÁCH TRANG LỖI 404 ---\n";
      pagesWith404.forEach((url) => {
        summaryReport += ` - ${url}\n`;
      });
      summaryReport += "\n";
    }

    if (pagesWithMissingAlt.length > 0) {
      summaryReport += "--- DANH SÁCH TRANG CÓ ẢNH THIẾU ALT ---\n";
      pagesWithMissingAlt.forEach(({ urlTrang, images }) => {
        summaryReport += `\n=> Trang: ${urlTrang}\n`;
        images.forEach((imgUrl) => {
          summaryReport += `    - Ảnh thiếu alt: ${imgUrl}\n`;
        });
      });
      summaryReport += "\n";
    }

    summaryReport += "--- ĐỀ XUẤT CẢI THIỆN CHUNG ---\n";
    summaryReport +=
      "- Đảm bảo tất cả các trang quan trọng có thẻ H1, title và description đầy đủ.\n";
    summaryReport +=
      "- Tối ưu độ dài title (10-70 ký tự) và description (50-160 ký tự).\n";
    summaryReport += "- Kiểm tra và sửa các liên kết hỏng (trang 404).\n";
    summaryReport +=
      "- Thêm thuộc tính alt cho tất cả các ảnh để cải thiện khả năng tiếp cận và SEO hình ảnh.\n";
    summaryReport +=
      "- Đảm bảo thẻ canonical URL được thiết lập chính xác cho mỗi trang.\n";
    summaryReport +=
      "- Sử dụng thẻ viewport responsive để tối ưu hiển thị trên các thiết bị di động.\n";
    summaryReport += "\n=== BÁO CÁO CHI TIẾT TỪNG URL ===\n\n";

    const reportFile = path.join(domainFolder, "seo_report.txt");
    fs.writeFileSync(
      reportFile,
      summaryReport + seoReports.join("\n\n"), // Ghi báo cáo tổng hợp trước, rồi đến chi tiết
      "utf-8"
    );
    console.log("📄 Đã lưu báo cáo SEO chi tiết và tổng hợp tại:", reportFile);

    // Lưu báo cáo SEO tổng hợp vào MongoDB
    const seoSummary = {
      domain: new URL(startUrl).hostname,
      sitemapUsed: path.basename(generatedSitemapPath),
      totalUrlsAnalyzed: visited.size,
      totalMissingAltImages,
      total404Pages,
      pagesWith404,
      pagesWithMissingAlt,
      createdAt: new Date(),
    };
    await seoSummaryCollection.insertOne(seoSummary);
    console.log("📊 Đã lưu báo cáo tổng hợp vào MongoDB.");
  } catch (err) {
    console.error("Lỗi nghiêm trọng khi chạy chương trình:", err);
  } finally {
    // --- Đóng trình duyệt và kết nối DB ---
    if (browser) {
      await browser.close();
      console.log("Đã đóng trình duyệt.");
    }
    if (client) {
      await client.close();
      console.log("Đã đóng kết nối MongoDB.");
    }
    console.log("Chương trình hoàn tất.");
  }
}

// --- Chạy chương trình ---
main(startUrl);
