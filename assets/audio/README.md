# Ambient audio (cozy / lofi)

Drop 3-5 ambient tracks here (mp3 / m4a / wav / ogg). The reel generator picks
one at random per build, trims to ~13s, fades in/out.

## FB Content ID safety

Facebook's audio matcher is aggressive — even royalty-free music can get muted.
**Ambient sounds (rain, fire, café, kitchen)** are the safest because they
rarely match any track in FB's library.

## Recommended free sources (CC0 / public domain)

- **freesound.org** — filter by license = CC0. Search: `rain on window`,
  `fireplace crackle`, `coffee shop ambience`, `vinyl crackle`, `kitchen
  morning`, `wind chimes`. Download mp3.
- **pixabay.com/sound-effects/** — all free, no attribution required.
- **YouTube Audio Library** — free, FB-friendly. `youtube.com/audiolibrary`.
- **uppbeat.io / mixkit.co** — free with attribution; less safe than ambient
  sounds for FB.

## Suggested starter set

Pick one from each row:

| Vibe | Search term |
|---|---|
| Rainy window | `rain on window long` |
| Fire / candles | `fireplace crackling` |
| Café | `coffee shop ambience` |
| Lofi | `lofi loop no copyright` |
| Nature | `forest morning birds` |

Aim for ≥30s long; the script trims to fit. After dropping files, commit them:

```bash
git add assets/audio/*.mp3
git commit -m "Add ambient audio for reel generator"
git push
```
