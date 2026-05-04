# reels-source

Drop your Reels MP4 files here, then add a row to `reels_queue` pointing at the
relative path:

```bash
npx wrangler d1 execute fb-growth --remote --command "
  INSERT INTO reels_queue (video_path, caption, hashtags, scheduled_at)
  VALUES (
    'reels-source/2026-05-decor-set-01.mp4',
    'caption here',
    '#decor #nhaxinh #homedecor',
    unixepoch() + 600
  );
"
```

The cron workflow runs every 5 minutes, picks up rows with `status='PENDING'`
and `scheduled_at <= now`, reads the file via the GitHub Actions checkout, and
POSTs bytes directly to the Facebook Reels upload API.

## File limits

- Single file: keep under 100MB (GitHub warns at 50MB, hard fail at 100MB).
  Reels are usually 15-30s = 5-30MB, fits easily.
- Repo total: under 1GB total. After publishing, you can delete the file from
  the repo (the published video already lives on Facebook).

## Cleanup script suggestion

After a reel is published successfully (status=`PUBLISHED`), the file is no
longer needed. Periodically:

```bash
git rm reels-source/<old-file>.mp4
git commit -m "remove published reel"
git push
```
