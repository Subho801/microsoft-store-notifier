// Microsoft Store — Paid Games Temporarily Free Notifier

const BASE = 'https://apps.microsoft.com/api/products/search';
const fs = require('fs');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const POSTED_FILE = 'posted.json';

const MICROSOFT_LOGO =
  'https://raw.githubusercontent.com/Subho801/microsoft-store-notifier/main/assets/microsoft.png';

const FOOTER_LOGO =
  'https://raw.githubusercontent.com/Subho801/microsoft-store-notifier/main/assets/footer.png';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function sessionTokenFrom(cursor) {
  return Buffer.from(cursor, 'base64')
    .toString('utf8')
    .match(/s=([^&]+)/)[1];
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
        return {
          status: 400,
          data: null,
        };
      }

      console.log(`[HTTP ${res.status}] Retrying...`);

      await sleep(1000 * (i + 1));
    } catch (err) {
      console.log(`[REQUEST ERROR] ${err.message}`);

      await sleep(1000 * (i + 1));
    }
  }

  return {
    status: 403,
    data: null,
  };
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
    return JSON.parse(
      fs.readFileSync(POSTED_FILE, 'utf8')
    );
  } catch {
    console.log('[WARN] Could not read posted.json');
    return {};
  }
}

function savePosted(posted) {
  fs.writeFileSync(
    POSTED_FILE,
    JSON.stringify(posted, null, 2)
  );
}

function getGameImage(product) {
  // Prefer poster art.
  if (product.posterArtUrl) {
    return product.posterArtUrl;
  }

  // Fallback to icon.
  if (product.iconUrl) {
    return product.iconUrl;
  }

  // Fallback to the images array.
  const image = product.images?.find(
    img => img.url
  );

  return image?.url || null;
}

async function sendDiscord(game) {
  if (!WEBHOOK_URL) {
    console.log(
      '[ERROR] DISCORD_WEBHOOK_URL is not set.'
    );

    return false;
  }

  const oldPrice =
    game.strikeThroughPrice ||
    `$${game.msrp}`;

  const embed = {
    author: {
      name: 'Microsoft Store - Free Games',
      icon_url: MICROSOFT_LOGO,
    },

    title: game.title,

    url: game.url,

    description:
      `**Deal**\n` +
      `~~${oldPrice}~~ **FREE** (${game.badgeText || '-100%'})`,

    footer: {
      text: "Subho's MS Store Freebie Informer",
      icon_url: FOOTER_LOGO,
    },
  };

  if (game.imageUrl) {
    embed.image = {
      url: game.imageUrl,
    };
  }

  const payload = {
    embeds: [embed],
  };

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',
      },

      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.log(
        `[DISCORD ERROR] HTTP ${res.status}`
      );

      return false;
    }

    console.log(
      `[DISCORD] Sent: ${game.title}`
    );

    return true;
  } catch (err) {
    console.log(
      `[DISCORD ERROR] ${err.message}`
    );

    return false;
  }
}

async function processProducts(products, posted) {
  for (const p of products) {
    if (!isPaidNowFree(p)) {
      continue;
    }

    const game = {
      productId: p.productId,
      title: p.title,
      msrp: p.priceInfo.msrp,
      price: p.priceInfo.price,
      badgeText: p.priceInfo.badgeText,
      strikeThroughPrice:
        p.priceInfo.strikeThroughPrice,
      displayPrice:
        p.priceInfo.displayPrice,
      imageUrl: getGameImage(p),
      url: `https://apps.microsoft.com/detail/${p.productId}`,
    };

    console.log(
      `\n🎯 FOUND: ${game.title}`
    );

    console.log(
      `   ${game.strikeThroughPrice || `$${game.msrp}`} → FREE`
    );

    // Already sent previously.
    if (posted[game.productId]) {
      console.log(
        `   Already posted — skipping.`
      );

      continue;
    }

    // SEND IMMEDIATELY.
    const sent = await sendDiscord(game);

    if (sent) {
      posted[game.productId] = {
        title: game.title,
        msrp: game.msrp,
        postedAt: new Date().toISOString(),
        url: game.url,
      };

      // Save immediately so a later crash
      // doesn't cause duplicate notifications.
      savePosted(posted);
    }
  }
}

async function scanBucket(price, posted, stats) {
  console.log(`\n========== ${price.toUpperCase()} ==========`);

  let first = await fetchPage(price, '');

  if (!first.data) {
    console.log(
      `[${price}] Failed to fetch first page.`
    );

    return;
  }

  let products = first.data.productsList || [];

  stats.scanned += products.length;

  console.log(
    `[${price}] First page: ${products.length}`
  );

  // PROCESS IMMEDIATELY
  await processProducts(products, posted);

  let token = sessionTokenFrom(
    first.data.cursor
  );

  let offset = 20;
  let refreshTries = 0;

  while (
    offset < 10000 &&
    refreshTries < 5
  ) {
    const result = await fetchPage(
      price,
      makeCursor(offset, token)
    );

    if (result.status === 400) {
      console.log(
        `[${price}] Microsoft pagination limit reached.`
      );

      break;
    }

    if (!result.data) {
      refreshTries++;

      console.log(
        `[${price}] Refreshing cursor ` +
        `(${refreshTries}/5)...`
      );

      await sleep(
        2000 * refreshTries
      );

      const fresh = await fetchPage(
        price,
        ''
      );

      if (!fresh.data) {
        continue;
      }

      token = sessionTokenFrom(
        fresh.data.cursor
      );

      continue;
    }

    refreshTries = 0;

    products =
      result.data.productsList || [];

    if (products.length === 0) {
      console.log(
        `[${price}] No more products.`
      );

      break;
    }

    stats.scanned += products.length;

    // PROCESS THIS PAGE IMMEDIATELY.
    await processProducts(
      products,
      posted
    );

    offset += 20;

    // Less noisy than the old logger.
    if (
      offset % 200 === 0 ||
      products.length < 20
    ) {
      console.log(
        `[${price}] Offset ${offset} — ` +
        `${stats.scanned} scanned`
      );
    }

    await sleep(700);
  }
}

async function main() {
  console.log(
    'Microsoft Store Freebie Informer'
  );

  console.log(
    '================================'
  );

  if (!WEBHOOK_URL) {
    console.log(
      '[ERROR] DISCORD_WEBHOOK_URL is missing.'
    );

    process.exit(1);
  }

  const posted = loadPosted();

  const stats = {
    scanned: 0,
  };

  // SALE FIRST
  await scanBucket(
    'Sale',
    posted,
    stats
  );

  // FREE SECOND
  await scanBucket(
    'Free',
    posted,
    stats
  );

  console.log(
    '\n================================'
  );

  console.log(
    `Finished. Total products scanned: ${stats.scanned}`
  );

  console.log(
    '================================'
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
