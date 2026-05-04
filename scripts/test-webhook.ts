// Local test script: simulates a Facebook webhook POST to your deployed Worker.
// Useful to verify the pipeline works end-to-end without waiting for real FB events.
//
// Usage:
//   FB_APP_SECRET=... FB_PAGE_ID=... WORKER_URL=https://...workers.dev \
//   npx tsx scripts/test-webhook.ts

import { createHmac } from 'node:crypto';

const APP_SECRET = process.env.FB_APP_SECRET;
const PAGE_ID = process.env.FB_PAGE_ID;
const WORKER_URL = process.env.WORKER_URL;

if (!APP_SECRET || !PAGE_ID || !WORKER_URL) {
  console.error('Missing env: FB_APP_SECRET, FB_PAGE_ID, WORKER_URL');
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const fakeUserId = '999000000000001';
const fakePostId = `${PAGE_ID}_test${now}`;
const fakeCommentId = `${fakePostId}_${now}`;

const payload = {
  object: 'page',
  entry: [
    {
      id: PAGE_ID,
      time: now * 1000,
      changes: [
        {
          field: 'feed',
          value: {
            item: 'comment',
            verb: 'add',
            comment_id: fakeCommentId,
            post_id: fakePostId,
            from: { id: fakeUserId, name: 'Test User' },
            message: 'shop ơi giá bao nhiêu vậy',
            created_time: now,
          },
        },
      ],
    },
  ],
};

const body = JSON.stringify(payload);
const sig = 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');

console.log('POSTing to', `${WORKER_URL}/webhook`);
console.log('Body:', body);

const res = await fetch(`${WORKER_URL}/webhook`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Hub-Signature-256': sig,
  },
  body,
});

console.log('Response:', res.status, await res.text());
