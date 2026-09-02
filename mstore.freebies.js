// Microsoft Store — Paid Games Temporarily Free Notifier

const BASE = 'https://apps.microsoft.com/api/products/search';
const fs = require('fs');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const POSTED_FILE = 'posted.json';

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

      console.log(`HTTP ${res.status}, retrying...`);

      await sleep(1000 * (i + 1));
    } catch (err) {
      console.log(`Request error: ${err.message}`);
      await sleep(1000 * (i + 1));
    }
  }

  return {
    status: 403,
    data: null,
  };
}

async function scanBucket(price, sink) {
  console.log(`\nScanning ${price} bucket...`);

  let { data } = await fetchPage(price, '');

  if (!data) {
    console.log(`Failed to fetch ${price} bucket.`);
    return;
  }

  console.log(`First page: ${data.productsList.length}`);

  data.productsList.forEach(p => {
    sink.set(p.productId, p);
  });

  let token = sessionTokenFrom(data.cursor);
  let offset = 20;
  let refreshTries = 0;

  while (offset < 10000 && refreshTries < 5) {
    console.log(`Fetching ${price} offset ${offset}...`);

    const {
      status,
      data: page,
    } = await fetchPage(
      price,
      makeCursor(offset, token)
    );

    if (status === 400) {
      console.log(
        `Microsoft pagination limit reached at offset ${offset}.`
      );
      break;
    }

    if (!page) {
      refreshTries++;

      console.log(
        `Page failed. Refreshing cursor (${refreshTries}/5)...`
      );

      await sleep(2000 * refreshTries);

      const fresh = await fetchPage(price, '');

      if (!fresh.data) {
        continue;
      }

      token = sessionTokenFrom(fresh.data.cursor);
      continue;
    }

    refreshTries = 0;

    if (!page.productsList || page.productsList.length === 0) {
      console.log('No more products.');
      break;
    }

    page.productsList.forEach(p => {
      sink.set(p.productId, p);
    });

    console.log(`  ${page.productsList.length} results`);

    offset += 20;

    await sleep(700);
  }
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
    return {};
  }
}

function savePosted(posted) {
  fs.writeFileSync(
    POSTED_FILE,
    JSON.stringify(posted, null, 2)
  );
}

async function sendDiscord(game) {
  if (!WEBHOOK_URL) {
    console.log(
      'DISCORD_WEBHOOK_URL not set — skipping Discord notification.'
    );
    return false;
  }

  const oldPrice =
    game.strikeThroughPrice ||
    `$${game.msrp}`;

  const payload = {
    embeds: [
      {
        title: '🎮 Microsoft Store — FREE',
        description:
          `**${game.title}**\n\n` +
          `~~${oldPrice}~~ → **FREE**\n\n` +
          `[Get it on Microsoft Store](${game.url})`,
        fields: [
          {
            name: 'Original Price',
            value: oldPrice,
            inline: true,
          },
          {
            name: 'Discount',
            value: game.badgeText || '-100%',
            inline: true,
          },
        ],
        url: game.url,
        footer: {
          text: 'Microsoft Store Free Game',
        },
      },
    ],
  };

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.log(
      `Discord webhook failed: HTTP ${res.status}`
    );
    return false;
  }

  console.log(`Discord notification sent: ${game.title}`);
  return true;
}

async function main() {
  const all = new Map();

  // IMPORTANT: Sale first
  await scanBucket('Sale', all);

  // Then Free
  await scanBucket('Free', all);

  console.log('\n================================');
  console.log('TOTAL UNIQUE PRODUCTS');
  console.log('================================');
  console.log(all.size);

  const deals = Array.from(all.values())
    .filter(isPaidNowFree)
    .map(p => ({
      productId: p.productId,
      title: p.title,
      msrp: p.priceInfo.msrp,
      price: p.priceInfo.price,
      badgeText: p.priceInfo.badgeText,
      strikeThroughPrice: p.priceInfo.strikeThroughPrice,
      displayPrice: p.priceInfo.displayPrice,
      url: `https://apps.microsoft.com/detail/${p.productId}`,
    }));

  console.log('\n================================');
  console.log('TEMPORARILY FREE');
  console.log('================================');

  if (deals.length === 0) {
    console.log('No paid games currently free.');
  } else {
    deals.forEach(g => {
      console.log(
        `${g.title} — was ${
          g.strikeThroughPrice || `$${g.msrp}`
        } — ${g.url}`
      );
    });
  }

  fs.writeFileSync(
    'result.json',
    JSON.stringify(deals, null, 2)
  );

  // --------------------------------
  // Discord / posted.json
  // --------------------------------

  const posted = loadPosted();

  let newDeals = 0;

  for (const game of deals) {
    if (posted[game.productId]) {
      console.log(
        `Already posted: ${game.title}`
      );
      continue;
    }

    const sent = await sendDiscord(game);

    if (sent) {
      posted[game.productId] = {
        title: game.title,
        postedAt: new Date().toISOString(),
        msrp: game.msrp,
        url: game.url,
      };

      newDeals++;
    }
  }

  savePosted(posted);

  console.log(
    `\nFound ${deals.length} paid games currently free.`
  );

  console.log(
    `New Discord notifications: ${newDeals}`
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
