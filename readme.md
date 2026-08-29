# DejaPost

DejaPost is an automated repost detector for Reddit communities. It watches every new post as it's submitted, compares it against recent posts in the same subreddit, and alerts (or acts on) the moderator team when it finds something that looks like a duplicate. It will detect video, image and text reposts alike.

## Overview

Reposts, the same image, video, or text post shared again days or weeks later, are one of the most common complaints moderators deal with. DejaPost solves this by fingerprinting every post's content into a compact "signature" and comparing that signature against the signatures of recent posts already stored by the app. If two posts are similar enough, DejaPost treats the newer one as a probable repost.

**Who it's for:** subreddit moderator teams who want repost detection to happen automatically, without a human needing to manually search for duplicates every time something is posted.

### DejaPost's standout feature: it actually watches the whole video

Most repost checkers on Reddit either can't handle video posts at all, or only check a single thumbnail frame. This makes them extremely unreliable, because you can easily bypass detection by cropping the video frames, trimming the opening seconds, or adding simple overlays like text and black padding. This doesn't even need to happpen on purpose, as clips are often cropped, editorialized and watermarked before actually being reposted.

When DejaPost looks at a video, it goes far beyond simply looking at the thumbnail. It decodes the actual video and pulls a frame **once every second, all the way through**, fingerprinting each one individually. When comparing 2 videos, instead of simply lining up frame 1 against frame 1, it checks every frame against the corresponding frame in the other video, and against every frame up to **3 seconds before and after it**, and keeps the closest match it finds. This sliding window means trimming, padding, or shifting a clip by a few seconds cannot throw off the comparison, as the matching frames are still found and compared directly. Because the whole video is fingerprinted second-by-second rather than judged on one frame, superficial edits like cropping, added blackframes, or text overlays don't hide a repost the way they would from a thumbnail-only checker. This is what makes DejaPost the repost checker built specifically to hold up against video reposts, not just detect the easy ones.

**DejaPost handles image, video and text posts across the board**: 
- **Videos** (Reddit-hosted video posts): as mentioned previously, frame-by-frame at 1 frame per second, deep into the video, with the 3-second sliding-window comparison described above.
- **Images** (`.png`, `.jpg`, `.gif`, and Reddit-hosted images): compared by their actual visual similarity, so a repost is caught even if it's been resized or cropped.
- **Text posts** — the post title is compared for close wording, catching posts that are copy-pasted or lightly reworded.

**What happens when a repost is found:** DejaPost always sends the moderator team a modmail message with a link to the original post it matched. Beyond that, it takes one of two actions depending on how you've configured it (see Settings below):
- **Report**: the post is reported to the subreddit's mod queue like a normal user report, so a moderator makes the final call.
- **Remove**: the post is automatically removed, and DejaPost leaves an automatically distinguished comment on the post letting the author know why it was removed and how to appeal.

**Critical operational notes:**
- DejaPost needs some history to compare against. When it's first installed on a subreddit, it automatically scans recent posts in the background to build up its initial library of fingerprints
- this can take a few minutes on active subreddits, and detection accuracy improves as this library fills in.
- If a moderator or Dejapost itself removes a post, DejaPost automatically forgets that post's fingerprint so it's no longer used as a match for future posts.
- Fingerprints are automatically deleted after 90 days, regardless of what repost check window you configure — DejaPost never keeps a permanent record of subreddit content.
- DejaPost stores only compact numeric fingerprints of posts (not copies of images, videos, or full text), and it only reaches out to two external addresses: Reddit's own video hosting (`v.redd.it`), to download a video posts's frames for comparison, and a storage address used to download a small internal video-processing component the app needs to run. No content ever leaves Reddit's infrastructure to a third party.

## Installing DejaPost

Install DejaPost onto your subreddit from the Reddit Developer Platform (Devvit) app listing page, the same way you'd install any other Community App:

1. Go to the DejaPost app listing on Reddit's app directory.
2. Click **Add to community** and choose the subreddit you moderate.
3. Approve the requested permissions (Reddit read/write access, and the two external addresses listed above).

Once installed, DejaPost starts working immediately. There is no further setup required to get basic protection, though we recommend reviewing the settings below so the sensitivity matches your community.

## Configuring DejaPost

All settings live in your subreddit's moderator tools, under **Mod Tools → Apps → DejaPost → Settings**. Every setting can be changed at any time and takes effect on the next new post.

| Setting | What it does |
|---|---|
| **Repost check window** | How far back DejaPost looks for a match: 30, 60, or 90 days. A shorter window is faster and focuses on recent reposts; a longer window catches posts reshared after a longer gap. |
| **Enforcement action** | What DejaPost does when it finds a likely repost: **Report post** (sends it to the mod queue for a human decision) or **Remove post** (removes it automatically and notifies the author). Every match also always sends a modmail alert regardless of this setting. |
| **Image Reposts Matching Tolerance** | How strict the image comparison is, from 51 to 99. Lower values require an almost-exact visual match; higher values allow more visual variation (cropping, re-compression, filters) before something is flagged. |
| **Video Reposts Matching Tolerance** | Same idea as image tolerance, but for video frame comparison. |
| **Text Reposts Matching Tolerance** | Same idea as image tolerance, but for text post title comparison. |

**Choosing tolerance values:** if DejaPost is flagging posts that clearly aren't reposts, lower the relevant tolerance number (require a closer match). If it's missing reposts you'd expect it to catch, raise the number (allow looser matches). We recommend starting with the defaults and adjusting after observing a few days of modmail alerts.

## Using DejaPost day to day

Once configured, DejaPost runs on its own. Moderators don't need to take any action for it to work:

1. A user submits a new post.
2. DejaPost fingerprints the post and compares it against recent posts.
3. If a likely match is found, your mod team receives a modmail message titled "DejaPost has detected a possible repost," containing a link to the original post.
4. Depending on your **Enforcement action** setting, the new post is either sent to the mod queue as a report, or removed with an automatic comment explaining the removal to the post's author.

If a post is removed and you disagree with the call, simply approve the post as you normally would, DejaPost will not take further action against it, and its fingerprint is cleared from memory so it won't cause repeat false flags.

## Getting help

If you require any support regarding DejaPost, please send a modmail at r/DejaPost. Alternatively, you can make a post there.