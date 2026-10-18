
const BASE = 'https://apps.microsoft.com/api/products/search';
const fs = require('fs');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const POSTED_FILE = 'posted.json';
const FEED_FILE = 'microsoft.json';

const MICROSOFT_LOGO =
  'https://raw.githubusercontent.com/Subho801/microsoft-store-notifier/main/assets/microsoft.png';

const FOOTER_LOGO =
  'https://raw.githubusercontent.com/Subho801/microsoft-store-notifier/main/assets/footer.png';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function sessionTokenFrom(cursor) {
  const match = Buffer.from(cursor, 'base64')
    .toString('utf8')
    .match(/s=([^&]+)/);

  if (!match) {
    throw new Error('Could not extract Microsoft pagination token.');
  }

  return match[1];
}

function makeCursor(offset, token) {
  return Buffer.from(`o=${offset}&b=&s=${token}`).toString('base64');
}

async function fetchPage(price, cursor, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const params = new URLSearchParams({
        query: '*',
        mediaType: 'games',
        age: 'all',
        price,
        category: 'all',
        subscription: 'all',
        cursor,
        gl: 'US',
        hl: 'en-US',
      });

      const res = await fetch(`${BASE}?${params}`, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
      });

      if (res.ok) {
        return {
          status: 200,
          data: await res.json(),
        };
      }

      if (res.status === 400) {
        return { status: 400, data: null };
      }

      console.log(`[HTTP ${res.status}] Retrying...`);
      await sleep(1000 * (i + 1));
    } catch (err) {
      console.log(`[REQUEST ERROR] ${err.message}`);
      await sleep(1000 * (i + 1));
    }
  }

  return { status: 403, data: null };
}

function isPaidNowFree(p) {
  return (
    p.priceInfo &&
    Number(p.priceInfo.msrp) > 0 &&
    Number(p.priceInfo.price) === 0
  );
}

function loadPosted() {
  if (!fs.existsSync(POSTED_FILE)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(POSTED_FILE, 'utf8'));
  } catch {
    console.log('[WARN] Could not read posted.json');
    return {};
  }
}

function savePosted(posted) {
  fs.writeFileSync(POSTED_FILE, JSON.stringify(posted, null, 2));
}

function getGameImage(product) {
  if (product.posterArtUrl) return product.posterArtUrl;
  if (product.iconUrl) return product.iconUrl;

  const image = product.images?.find(img => img.url);
  return image?.url || null;
}

function makeGame(product) {
  return {
    productId: product.productId,
    title: product.title,
    msrp: product.priceInfo.msrp,
    price: product.priceInfo.price,
    badgeText: product.priceInfo.badgeText,
    strikeThroughPrice: product.priceInfo.strikeThroughPrice,
    displayPrice: product.priceInfo.displayPrice,
    imageUrl: getGameImage(product),
    url: `https://apps.microsoft.com/detail/${product.productId}`,
  };
}

function addToWebsiteFeed(game, feedGames) {
  // A separate feed for the website; this does not affect Discord history.
  feedGames[game.productId] = {
    id: game.productId,
    title: game.title,
    url: game.url,
    image: game.imageUrl,
    original_price: game.strikeThroughPrice || `$${game.msrp}`,
    current_price: 'FREE',
    status: 'free',
  };
}

async function sendDiscord(game) {
  if (!WEBHOOK_URL) {
    console.log('[ERROR] DISCORD_WEBHOOK_URL is not set.');
    return false;
  }

  const oldPrice = game.strikeThroughPrice || `$${game.msrp}`;

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
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (!res.ok) {
      console.log(`[DISCORD ERROR] HTTP ${res.status}`);
      return false;
    }

    console.log(`[DISCORD] Sent: ${game.title}`);
    return true;
  } catch (err) {
    console.log(`[DISCORD ERROR] ${err.message}`);
    return false;
  }
}

async function processProducts(products, posted, feedGames) {
  for (const p of products) {
    if (!isPaidNowFree(p)) continue;

    const game = makeGame(p);

    // Include all currently discovered free games, even previously notified ones.
    addToWebsiteFeed(game, feedGames);

    console.log(`\n🎯 FOUND: ${game.title}`);
    console.log(`   ${game.strikeThroughPrice || `$${game.msrp}`} → FREE`);

    if (posted[game.productId]) {
      console.log('   Already posted — skipping Discord notification.');
      continue;
    }

    const sent = await sendDiscord(game);

    if (sent) {
      posted[game.productId] = {
        title: game.title,
        msrp: game.msrp,
        postedAt: new Date().toISOString(),
        url: game.url,
      };

      // Preserve the existing immediate-save behavior.
      savePosted(posted);
    }
  }
}

async function scanBucket(price, posted, feedGames, stats) {
  console.log(`\n========== ${price.toUpperCase()} ==========`);

  const first = await fetchPage(price, '');

  if (!first.data) {
    console.log(`[${price}] Failed to fetch first page.`);
    stats.failedBuckets.push(price);
    return;
  }

  let products = first.data.productsList || [];
  stats.scanned += products.length;

  console.log(`[${price}] First page: ${products.length}`);

  await processProducts(products, posted, feedGames);

  let token = sessionTokenFrom(first.data.cursor);
  let offset = 20;
  let refreshTries = 0;

  while (refreshTries < 5) {
    const result = await fetchPage(price, makeCursor(offset, token));

    if (result.status === 400) {
      console.log(`[${price}] Microsoft pagination limit reached.`);
      break;
    }

    if (!result.data) {
      refreshTries++;

      console.log(`[${price}] Refreshing cursor (${refreshTries}/5)...`);
      await sleep(2000 * refreshTries);

      const fresh = await fetchPage(price, '');

      if (!fresh.data) continue;

      token = sessionTokenFrom(fresh.data.cursor);
      continue;
    }

    refreshTries = 0;
    products = result.data.productsList || [];

    if (products.length === 0) {
      console.log(`[${price}] No more products.`);
      break;
    }

    stats.scanned += products.length;
    await processProducts(products, posted, feedGames);

    offset += 20;

    if (offset % 200 === 0 || products.length < 20) {
      console.log(`[${price}] Offset ${offset} — ${stats.scanned} scanned`);
    }

    await sleep(700);
  }
}

function saveWebsiteFeed(feedGames, stats) {
  const games = Object.values(feedGames);

  const feed = {
    source: 'Microsoft Store',
    updated_at: new Date().toISOString(),
    total_found: games.length,
    scan_complete: stats.failedBuckets.length === 0,
    games,
  };

  fs.writeFileSync(FEED_FILE, JSON.stringify(feed, null, 2) + '\n');
  console.log(`[WEBSITE] Saved ${games.length} games to ${FEED_FILE}`);
}

async function main() {
  console.log('Microsoft Store Freebie Informer');
  console.log('================================');

  if (!WEBHOOK_URL) {
    console.log('[ERROR] DISCORD_WEBHOOK_URL is missing.');
    process.exit(1);
  }

  const posted = loadPosted();
  const feedGames = {};

  const stats = {
    scanned: 0,
    failedBuckets: [],
  };

  // Sale first, then Free — unchanged from your current scan order.
  await scanBucket('Sale', posted, feedGames, stats);
  await scanBucket('Free', posted, feedGames, stats);

  // Don't overwrite a previously good feed with an incomplete scan.
  if (stats.failedBuckets.length === 0) {
    saveWebsiteFeed(feedGames, stats);
  } else {
    console.log(
      `[WEBSITE] Feed not overwritten because these buckets failed: ${stats.failedBuckets.join(', ')}`
    );
    process.exitCode = 1;
  }

  console.log('\n================================');
  console.log(`Finished. Total products scanned: ${stats.scanned}`);
  console.log('================================');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
