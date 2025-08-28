import express from "express";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import archiver from "archiver";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({
  origin: "*",
  exposedHeaders: [
    "X-HTML-COUNT",
    "X-CSS-COUNT",
    "X-JS-COUNT",
    "X-IMAGE-COUNT",
    "X-TOTAL-FILES"
  ]
}));
app.use(express.json({ limit: "1mb" }));

// helper: safe filename
function safeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || `file_${uuidv4()}`;
}

app.post("/getcode", async (req, res) => {
  const { url } = req.body;
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "URL tidak valid. Pastikan pakai http:// atau https:// " });
  }

  const timestamp = Date.now();
  const tempDir = path.join(__dirname, `temp_${timestamp}_${Math.floor(Math.random() * 10000)}`);
  await fsPromises.mkdir(tempDir, { recursive: true });

  // stats
  let stats = { html: 0, css: 0, js: 0, images: 0, others: 0 };

  try {
    // ambil HTML utama
    const { data: html } = await axios.get(url, { timeout: 15000, headers: { "User-Agent": "WebScraperPro/1.0" }});
    await fsPromises.writeFile(path.join(tempDir, "index.html"), html);
    stats.html = 1;

    const $ = cheerio.load(html);
    const resources = new Set();

    $("script[src]").each((_, el) => resources.add($(el).attr("src")));
    $("link[rel='stylesheet']").each((_, el) => resources.add($(el).attr("href")));
    $("img[src]").each((_, el) => resources.add($(el).attr("src")));
    $("iframe[src]").each((_, el) => resources.add($(el).attr("src")));
    // also inline <link rel="preload" as="image"> or others
    $("link[href]").each((_, el) => {
      const rel = ($(el).attr("rel") || "").toLowerCase();
      if (!rel || rel === "preload" || rel === "icon" || rel === "shortcut icon") resources.add($(el).attr("href"));
    });

    // download resources (serial to reduce concurrency issues)
    for (const resUrl of resources) {
      if (!resUrl) continue;
      try {
        const fullUrl = new URL(resUrl, url).href;
        const parsed = new URL(fullUrl);
        // derive filename
        let fileName = path.basename(parsed.pathname) || parsed.hostname;
        fileName = safeFileName(fileName);
        // if filename has no extension, try to guess from path or add unique suffix
        if (!path.extname(fileName)) {
          const extGuess = path.extname(parsed.pathname) || "";
          fileName = `${fileName}${extGuess || ".bin"}`;
        }
        const filePath = path.join(tempDir, fileName);
        const resp = await axios.get(fullUrl, { responseType: "arraybuffer", timeout: 15000, headers: { "User-Agent": "WebScraperPro/1.0" }});
        await fsPromises.writeFile(filePath, resp.data);

        const ext = path.extname(fileName).toLowerCase();
        if (ext === ".css") stats.css++;
        else if (ext === ".js") stats.js++;
        else if (ext.match(/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/)) stats.images++;
        else stats.others++;
      } catch (err) {
        // skip file if gagal download
        console.warn("⚠️ Gagal download resource:", resUrl, err.message);
      }
    }

    const totalFiles = stats.html + stats.css + stats.js + stats.images + stats.others;

    // set headers with stats so client dapat menampilkan sebelum/atau setelah download
    res.setHeader("X-HTML-COUNT", String(stats.html));
    res.setHeader("X-CSS-COUNT", String(stats.css));
    res.setHeader("X-JS-COUNT", String(stats.js));
    res.setHeader("X-IMAGE-COUNT", String(stats.images));
    res.setHeader("X-TOTAL-FILES", String(totalFiles));

    // stream ZIP langsung ke client
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="website-source-${timestamp}.zip"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", err => {
      console.error("Archiver error:", err);
      try { res.end(); } catch (e) {}
    });

    archive.pipe(res);
    // masukkan seluruh folder temp ke zip root
    archive.directory(tempDir, false);
    await archive.finalize();

    // ketika stream selesai, lakukan cleanup (archiver emits 'end' on stream finish)
    archive.on("end", async () => {
      try {
        await fsPromises.rm(tempDir, { recursive: true, force: true });
      } catch (e) {
        console.warn("Cleanup failed:", e.message);
      }
    });

    // also cleanup on response finish (in case archiver closed)
    res.on("finish", async () => {
      try {
        await fsPromises.rm(tempDir, { recursive: true, force: true });
      } catch (e) {}
    });

  } catch (err) {
    console.error("Error scraping:", err.message);
    // cleanup
    try { await fsPromises.rm(tempDir, { recursive: true, force: true }); } catch (e) {}
    return res.status(500).json({ error: "Gagal mengambil sumber: " + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});