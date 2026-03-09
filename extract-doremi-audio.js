/**
 * 도레미곰 오디오 URL 추출기
 *
 * GreatBooks 도레미곰 QR 페이지에서 실제 재생 가능한 오디오 URL을 자동 수집합니다.
 * - 낭독(A) / 뮤지컬(B) 두 카테고리
 * - 책 번호 1~53
 *
 * 사용법: node extract-doremi-audio.js
 * 출력:   results.json, debug-log.json
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// ─── 설정 ───────────────────────────────────────────────
const CONFIG = {
  baseUrl: "https://www.greatbooks.co.kr/qr_code/wb2/?cd=133",
  bookStart: 1,
  bookEnd: 53,
  timeout: 20000,
  audioWait: 3000, // 재생 버튼 클릭 후 대기
  retryCount: 1,
  outputFile: "results.json",
  debugFile: "debug-log.json",
};

// 오디오 파일 확장자 패턴
const AUDIO_EXT_RE = /\.(mp3|m4a|aac|wav|ogg|m3u8)(\?|$)/i;

// 오디오 content-type 패턴
const AUDIO_CT_RE = /^audio\//i;

// ─── 유틸리티 ────────────────────────────────────────────

function padNum(n) {
  return String(n).padStart(2, "0");
}

function buildUrl(bookNum, type) {
  return `${CONFIG.baseUrl}${padNum(bookNum)}${type}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg) {
  const t = new Date().toLocaleTimeString("ko-KR");
  console.log(`[${t}] ${msg}`);
}

/** http → https 변환 */
function ensureHttps(url) {
  return url.replace(/^http:\/\//i, "https://");
}

// ─── 오디오 URL 추출 ─────────────────────────────────────

/**
 * 한 페이지에서 오디오 URL을 추출합니다.
 *
 * 탐지 전략:
 * 1. 네트워크 요청 모니터링 (URL 패턴 + content-type)
 * 2. DOM의 <audio>/<source> 태그 src 확인
 * 3. <script> 태그 내 오디오 URL 패턴 탐색
 * 4. 재생 버튼 클릭으로 동적 로딩 트리거
 */
async function extractAudioUrl(page, url, debugEntries) {
  const found = new Set();
  const networkLog = [];

  // 네트워크 요청 감시
  page.on("request", (req) => {
    const u = req.url();
    if (AUDIO_EXT_RE.test(u)) found.add(u);
  });

  page.on("response", (res) => {
    const u = res.url();
    const ct = res.headers()["content-type"] || "";
    networkLog.push({ url: u, status: res.status(), contentType: ct });
    if (AUDIO_CT_RE.test(ct)) found.add(u);
  });

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: CONFIG.timeout });

    // DOM에서 오디오 소스 탐색
    const domUrls = await page.evaluate(() => {
      const urls = [];

      // <audio>, <video>, <source> 태그
      document.querySelectorAll("audio, video, source").forEach((el) => {
        if (el.src) urls.push(el.src);
        if (el.currentSrc) urls.push(el.currentSrc);
      });

      // data-* 속성
      document.querySelectorAll("[data-src],[data-audio],[data-url],[data-file]").forEach((el) => {
        ["data-src", "data-audio", "data-url", "data-file"].forEach((attr) => {
          const v = el.getAttribute(attr);
          if (v) urls.push(v);
        });
      });

      // <script> 태그 내 URL 패턴
      document.querySelectorAll("script").forEach((s) => {
        const text = s.textContent || "";
        const m = text.match(
          /https?:\/\/[^\s"'<>]+\.(mp3|m4a|aac|wav|ogg|m3u8)(\?[^\s"'<>]*)?/gi
        );
        if (m) urls.push(...m);
      });

      return urls;
    });

    domUrls.forEach((u) => found.add(u));

    // 아직 못 찾았으면 재생 버튼 클릭 시도
    if (found.size === 0) {
      await tryClickPlay(page);
      await sleep(CONFIG.audioWait);

      // 클릭 후 DOM 재탐색
      const postUrls = await page.evaluate(() => {
        const urls = [];
        document.querySelectorAll("audio, video, source").forEach((el) => {
          if (el.src) urls.push(el.src);
          if (el.currentSrc) urls.push(el.currentSrc);
        });
        return urls;
      });
      postUrls.forEach((u) => found.add(u));
    }
  } catch (err) {
    log(`  ⚠ 페이지 로드 실패: ${err.message}`);
  }

  // 디버그 기록
  debugEntries.push({
    url,
    audioUrlsFound: [...found],
    networkRequests: networkLog.length,
  });

  // 유효한 URL 필터링 (blob:, data: 제외)
  const valid = [...found].filter(
    (u) => u && !u.startsWith("blob:") && !u.startsWith("data:")
  );

  // HTTPS로 통일하여 첫 번째 반환
  return valid.length > 0 ? ensureHttps(valid[0]) : null;
}

/**
 * 재생 버튼 클릭 시도.
 * 그레이트북스 QR 페이지의 jPlayer 기반 `.cp-play` 버튼을 우선 시도합니다.
 */
async function tryClickPlay(page) {
  const selectors = [
    ".cp-play",          // 그레이트북스 jPlayer 재생 버튼
    ".jp-play",
    'a[class*="play"]',
    'button[class*="play"]',
    'div[class*="play"]',
    "#play",
    "button",
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el && (await el.isVisible().catch(() => false))) {
        await el.click({ timeout: 2000 }).catch(() => {});
        return true;
      }
    } catch {
      // 다음 시도
    }
  }

  // JavaScript로 직접 재생 시도
  await page.evaluate(() => {
    document.querySelectorAll("audio").forEach((a) => a.play().catch(() => {}));
  }).catch(() => {});

  return false;
}

// ─── 재시도 래퍼 ──────────────────────────────────────────

async function processWithRetry(context, bookNum, type, debugLog) {
  const url = buildUrl(bookNum, type);

  for (let attempt = 0; attempt <= CONFIG.retryCount; attempt++) {
    if (attempt > 0) {
      log(`  🔄 재시도 (${attempt}/${CONFIG.retryCount}): ${type}`);
      await sleep(2000);
    }

    const page = await context.newPage();
    try {
      const audioUrl = await extractAudioUrl(page, url, debugLog);
      if (audioUrl) return audioUrl;
    } catch (err) {
      log(`  ⚠ 오류: ${err.message}`);
    } finally {
      await page.close();
    }
  }

  return null;
}

// ─── 메인 ────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(56));
  console.log("  도레미곰 오디오 URL 추출기");
  console.log(`  범위: 책 ${CONFIG.bookStart}번 ~ ${CONFIG.bookEnd}번`);
  console.log("=".repeat(56));
  console.log();

  const results = { narration: {}, musical: {} };
  const failures = [];
  const debugLog = [];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  for (let book = CONFIG.bookStart; book <= CONFIG.bookEnd; book++) {
    log(`📖 책 ${book}번 처리 중...`);

    // 낭독(A)
    const narUrl = await processWithRetry(context, book, "A", debugLog);
    if (narUrl) {
      results.narration[String(book)] = narUrl;
      log(`  ✅ 낭독(A): ${narUrl}`);
    } else {
      failures.push({ book, type: "narration(A)" });
      log(`  ❌ 낭독(A): 감지 실패`);
    }

    // 뮤지컬(B)
    const musUrl = await processWithRetry(context, book, "B", debugLog);
    if (musUrl) {
      results.musical[String(book)] = musUrl;
      log(`  ✅ 뮤지컬(B): ${musUrl}`);
    } else {
      failures.push({ book, type: "musical(B)" });
      log(`  ❌ 뮤지컬(B): 감지 실패`);
    }

    console.log();
  }

  await browser.close();

  // 결과 저장
  const outPath = path.join(__dirname, CONFIG.outputFile);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
  log(`✅ 결과 저장: ${outPath}`);

  // 디버그 로그 저장
  const dbgPath = path.join(__dirname, CONFIG.debugFile);
  fs.writeFileSync(
    dbgPath,
    JSON.stringify({ failures, log: debugLog }, null, 2),
    "utf-8"
  );
  log(`📝 디버그 로그: ${dbgPath}`);

  // 요약
  const nCount = Object.keys(results.narration).length;
  const mCount = Object.keys(results.musical).length;
  const total = CONFIG.bookEnd - CONFIG.bookStart + 1;

  console.log();
  console.log("=".repeat(56));
  console.log("  추출 완료 요약");
  console.log("=".repeat(56));
  console.log(`  낭독(A): ${nCount} / ${total} 성공`);
  console.log(`  뮤지컬(B): ${mCount} / ${total} 성공`);
  if (failures.length > 0) {
    console.log(`  실패: ${failures.length}건`);
    failures.forEach((f) => console.log(`    - 책 ${f.book}번 ${f.type}`));
  } else {
    console.log("  🎉 모든 책 추출 성공!");
  }
  console.log("=".repeat(56));
}

main().catch((err) => {
  console.error("치명적 오류:", err);
  process.exit(1);
});
