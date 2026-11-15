# YouTube API Services audit — answers to paste

Form: <https://support.google.com/youtube/contact/yt_api_form> → choose **"I would like to request an audit / quota extension"**.
Passing it lifts YouTube's lock that keeps API uploads **private**. Free to apply; Google replies by email (often a few weeks).

| Field | Answer |
|---|---|
| Google Cloud project number | `489755278210` |
| Project ID | `claude-youtube-514816` |
| API client name | Claude YouTube Connector |
| OAuth client ID | `489755278210-398kfsk2oun4nhu3rctdmcr42h5q345j.apps.googleusercontent.com` |
| Website | https://rezoxnemesis.github.io/claude-youtube-connector/ |
| Privacy policy | https://rezoxnemesis.github.io/claude-youtube-connector/privacy.html |
| Terms | https://rezoxnemesis.github.io/claude-youtube-connector/terms.html |
| Source code | https://github.com/RezoxNemesis/claude-youtube-connector |
| Channel using it | Vikas Tandon — https://www.youtube.com/channel/UCQlC2wD6FB-KL41hVJHZOog |
| Organisation type | Individual creator (personal, non-commercial tool) |
| Number of users | 1 (the channel owner only); not offered to the public |
| APIs used | YouTube Data API v3, YouTube Analytics API |

**Describe your use case (paste):**

> This is a private tool used only by me, the owner of the channel "Vikas Tandon", to manage my own channel with an AI assistant (Claude). I create original animated short films and videos myself; the tool uploads my finished videos to my own channel with the title, description, tags, thumbnail and publish schedule I choose, adds them to my playlists, lets me read and reply to comments on my videos, and reads my own channel analytics so I can plan content. It runs on my own computer (a local connector in the Claude desktop app) and, when my computer is off, as a GitHub Actions job in my own repository that uploads videos I placed in my own Google Drive folder. No other users, no third-party channels, no data is sold or shared, and nothing from YouTube is stored beyond the current request. Uploads currently get locked as private because the project is unaudited; I am requesting the audit so my own uploads can be published as I set them.

**How does your client use YouTube data / display it?**

> It only acts on my own channel. Video, playlist, comment and analytics data is shown to me inside my own Claude conversation to help me make decisions, and is not stored or displayed anywhere else. The tool links to the YouTube Terms of Service and Google Privacy Policy on its home page and in its privacy policy, and access can be revoked at any time from my Google Account permissions page.

**Quota:** the default allocation (100 uploads/day, 10,000 units/day) is enough — no extension needed.

Attach if asked: a short screen recording of Claude uploading a video through the connector and the resulting private video in YouTube Studio.
