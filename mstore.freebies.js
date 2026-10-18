
const BASE = 'https://apps.microsoft.com/api/products/search';
const fs = require('fs');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const POSTED_FILE = 'posted.json';

const MICROSOFT_LOGO =
  'https://raw.githubusercontent.com/Subho801/microsoft-store-notifier/main/assets/microsoft.png';

const FOOTER_LOGO =
  'https://raw.githubusercontent.com/Subho801/microsoft-store-notifier/main/assets/footer.png';

const MAX_PAGES_PER_BUCKET = 500;
const MAX_RETRIES = 5;
const PAGE_DELAY_MS = 900;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function loadPosted() {
  if (!fs.existsSync(POSTED_FILE)) return {};

  try {
    return JSON.parse(fs.readFileSync(POSTED_FILE, 'utf8'));
  } catch (err) {
    console.error('[WARN] Could not read posted.json:', err.message);
    return {};
  }
}

function savePosted(posted) {
  const tempFile = `${POSTED_FILE}.tmp`;

  fs.writeFileSync(tempFile, JSON.stringify(posted, null, 2));
  fs.renameSync(tempFile, POSTED_FILE);
}

function isPaidNowFree(product) {
  const info = product?.priceInfo;

  return (
    info &&
    Number(info.msrp) > 0 &&
    Number(info.price) === 0
  );
}

function getGameImage(product) {
  if (product.posterArtUrl) return product.posterArtUrl;
  if (product.iconUrl) return product.iconUrl;

  const image = product.images?.find(item => item.url);
  return image?.url || null;
}

async function fetchPage(price, cursor = null) {
  const params = new URLSearchParams({
    query: '*',
    mediaType: 'games',
    age: 'all',
    price,
    category: 'all',
    subscription: 'all',
    gl: 'US',
    hl: 'en-US',
  });

  // Use the cursor returned by Microsoft without reconstructing it.
  if (cursor) {
    params.set('cursor', cursor);
  }

  const url = `${BASE}?${params}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(20000),
      });

      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          data: await response.json(),
        };
      }

      const retryAfter = Number(response.headers.get('retry-after'));
      const retryable =
        response.status === 403 ||
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;

      if (!retryable) {
        console.error(`[HTTP ${response.status}] ${price} request failed.`);
        return {
          ok: false,
          status: response.status,
          data: null,
        };
      }

      if (attempt === MAX_RETRIES) {
        console.error(
          `[HTTP ${response.status}] Giving up after ${attempt} attempts.`
        );

        return {
          ok: false,
          status: response.status,
          data: null,
        };
      }

      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 60000)
        : Math.min(2000 * (2 ** (attempt - 1)), 20000);

      console.warn(
        `[HTTP ${response.status}] ${price}: retry ${attempt}/${MAX_RETRIES} in ${Math.ceil(delay / 1000)}s`
      );

      await sleep(delay);
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        console.error(
          `[REQUEST ERROR] ${price}: ${err.message}; retries exhausted.`
        );

        return {
          ok: false,
          status: 0,
          data: null,
        };
      }

      const delay = Math.min(2000 * (2 ** (attempt - 1)), 20000);

      console.warn(
        `[REQUEST ERROR] ${err.message}; retry ${attempt}/${MAX_RETRIES} in ${Math.ceil(delay / 1000)}s`
      );

      await sleep(delay);
    }
  }

  return { ok: false, status: 0, data: null };
}

async function sendDiscord(game) {
  if (!WEBHOOK_URL) {
    console.error('[ERROR] DISCORD_WEBHOOK_URL is not set.');
    return false;
  }

  const oldPrice =
    game.strikeThroughPrice || `$${game.msrp}`;

  const embed = {
    author: {
      name: 'Microsoft Store - Free Games',
      icon_url: MICROSOFT_LOGO,
    },
    title: game.title,
    url: game.url,
    description:
      `**🔥 Limited Time Free**\n` +
      `~~${oldPrice}~~ **FREE** (${game.badgeText || '-100%'})`,
    footer: {
      text: "Subho's MS Store Freebie Informer",
      icon_url: FOOTER_LOGO,
    },
  };

  if (game.imageUrl) {
    embed.image = { url: game.imageUrl };
  }

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      console.error(`[DISCORD ERROR] HTTP ${response.status}: ${game.title}`);
      return false;
    }

    console.log(`[DISCORD] Sent: ${game.title}`);
    return true;
  } catch (err) {
    console.error(`[DISCORD ERROR] ${game.title}: ${err.message}`);
    return false;
  }
}

async function processProducts(products, posted, stats) {
  for (const product of products) {
    if (!isPaidNowFree(product)) continue;

    const productId = product.productId;

    if (!productId || !product.title) continue;

    const game = {
      productId,
      title: product.title,
      msrp: product.priceInfo.msrp,
      price: product.priceInfo.price,
      badgeText: product.priceInfo.badgeText,
      strikeThroughPrice: product.priceInfo.strikeThroughPrice,
      imageUrl: getGameImage(product),
      url: `https://apps.microsoft.com/detail/${productId}`,
    };

    console.log(`\n🎯 FOUND: ${game.title}`);
    console.log(
      `   ${game.strikeThroughPrice || `$${game.msrp}`} → FREE`
    );

    if (posted[productId]) {
      console.log('   Already posted — skipping.');
      continue;
    }

    const sent = await sendDiscord(game);

    if (sent) {
      posted[productId] = {
        title: game.title,
        msrp: game.msrp,
        postedAt: new Date().toISOString(),
        url: game.url,
      };

      savePosted(posted);
      stats.notified++;
    }
  }
}

async function scanBucket(price, posted, stats) {
  console.log(`\n========== ${price.toUpperCase()} ==========`);

  let cursor = null;
  let pageNumber = 0;
  let previousCursor = null;

  while (pageNumber < MAX_PAGES_PER_BUCKET) {
    const result = await fetchPage(price, cursor);

    if (!result.ok || !result.data) {
      stats.incomplete = true;

      console.error(
        `[${price}] Scan incomplete at page ${pageNumber + 1}; ` +
        `HTTP status: ${result.status}.`
      );

      break;
    }

    const data = result.data;
    const products = data.productsList || [];

    pageNumber++;
    stats.scanned += products.length;

    console.log(
      `[${price}] Page ${pageNumber}: ${products.length} products ` +
      `(${stats.scanned} total across buckets)`
    );

    await processProducts(products, posted, stats);

    // An empty page usually means the current result set has ended.
    if (products.length === 0) {
      console.log(`[${price}] No products on this page; stopping.`);
      break;
    }

    // Microsoft provides the next cursor. Do not synthesize an offset.
    const nextCursor = data.cursor || null;

    if (!nextCursor) {
      console.log(`[${price}] No next cursor; reached the end.`);
      break;
    }

    if (nextCursor === cursor || nextCursor === previousCursor) {
      console.warn(
        `[${price}] Cursor did not advance. Stopping to avoid a loop.`
      );
      stats.incomplete = true;
      break;
    }

    previousCursor = cursor;
    cursor = nextCursor;

    await sleep(PAGE_DELAY_MS);
  }

  if (pageNumber >= MAX_PAGES_PER_BUCKET) {
    console.warn(
      `[${price}] Reached the ${MAX_PAGES_PER_BUCKET}-page safety limit.`
    );
    stats.incomplete = true;
  }

  console.log(`[${price}] Finished after ${pageNumber} page(s).`);
}

async function main() {
  console.log('Microsoft Store Freebie Informer');
  console.log('================================');

  if (!WEBHOOK_URL) {
    console.error('[ERROR] DISCORD_WEBHOOK_URL is missing.');
    process.exitCode = 1;
    return;
  }

  const posted = loadPosted();

  const stats = {
    scanned: 0,
    notified: 0,
    incomplete: false,
  };

  // Sale first, then Free.
  await scanBucket('Sale', posted, stats);
  await scanBucket('Free', posted, stats);

  console.log('\n================================');
  console.log(`Products scanned: ${stats.scanned}`);
  console.log(`New notifications sent: ${stats.notified}`);
  console.log(`Scan complete: ${stats.incomplete ? 'NO — check errors above' : 'no errors reported'}`);
  console.log('================================');

  // A failed or truncated scan should be visible as a failed GitHub Action.
  if (stats.incomplete) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('[FATAL ERROR]', err);
  process.exitCode = 1;
});
