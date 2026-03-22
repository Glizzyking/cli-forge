# larry-cli

AI-powered TikTok-to-Carousel content engine. Add TikTok links → AI analyzes them → builds a RAG knowledge base → generates new carousel posts → posts to TikTok as drafts at 4 PM daily.

## How it works

1. **Add TikToks** — Downloads with yt-dlp, analyzes with Gemini 2 Flash (multimodal), generates embeddings with Gemini text-embedding-004, stores in local JSON database
2. **RAG on create** — Finds the most relevant content from your TikTok database using cosine similarity on Gemini embeddings
3. **Generate carousel** — Gemini 2 Flash writes viral slide copy using your best-performing content as context
4. **Generate images** — Gemini Imagen 3 generates portrait 9:16 slides for each carousel card
5. **Host images** — Auto-uploads to Imgur (free hosting, public URLs)
6. **Post as draft** — Sends carousel to your TikTok inbox via the Content Posting API (`MEDIA_UPLOAD` mode) — you review and publish from the TikTok app

## Requirements

- Node.js 18+
- yt-dlp on PATH: `pip install yt-dlp`
- Gemini API key (google.ai/studio — free tier available)
- TikTok developer app (developers.tiktok.com — free)
- Imgur Client ID (api.imgur.com/oauth2/addclient — free)

## Setup

### 1. Configure API keys
```bash
node larry.js init
```

### 2. Set up TikTok app
1. Go to [developers.tiktok.com](https://developers.tiktok.com)
2. Create an app → add **Content Posting API** product
3. Set redirect URI: `http://localhost:8347/callback`
4. Copy your `client_key` and `client_secret`

### 3. Authorize your TikTok account
```bash
node larry.js auth
# Opens browser → authorizes → stores token locally
```

## Usage

```bash
# Add TikToks to the knowledge base
node larry.js add https://www.tiktok.com/t/ZTk1PdKcv/
node larry.js add https://www.tiktok.com/@user/video/123456

# View database
node larry.js list

# Create carousel and post as draft to TikTok
node larry.js create
node larry.js create --topic "productivity hacks"
node larry.js create --account myaccount

# Start daily scheduler at 4 PM
node larry.js schedule
node larry.js schedule --time 16:00

# Full pipeline test (no posting)
node larry.js test
```

## Multiple accounts

```bash
node larry.js auth myaccount2
node larry.js create --account myaccount2
node larry.js schedule --time 16:00 --account myaccount2
```

## How carousels are posted

Posts use TikTok's `MEDIA_UPLOAD` mode (`post_mode: "MEDIA_UPLOAD"`, `privacy_level: "SELF_ONLY"`). This sends the carousel to your **TikTok inbox** as a draft — you open TikTok, go to inbox, edit if needed, then publish. It never posts anything publicly without your review.

## Data storage

Everything is stored locally in `~/.larry-cli/`:
- `config.json` — API keys and settings
- `db.json` — TikTok content database + post history
- `tmp/` — Temporary download files (auto-cleaned)

## Based on

Larry's Marketing Experiments skill from [larrybrain.com](https://www.larrybrain.com/skills/larry-marketing) — the same system behind 300K+ TikTok views in 48 hours.
