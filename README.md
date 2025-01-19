# Cerbero Telegram Notification Bot
A simple telegram bot that notifies when one of the configured twitch channels goes live.

### Generate twitch access token

1) replace CLIENT_ID with your twitch client id and go to https://id.twitch.tv/oauth2/authorize?client_id=CLIENT_ID&redirect_uri=http://localhost&response_type=code&scope
2) take note of the access token in the redirect uri
3) replace CLIENT_ID, CLIENT_SECRET and AUTH_CODE then run the following command:
```bash
curl --location --request POST 'https://id.twitch.tv/oauth2/token?client_id=CLIENT_ID&client_secret=CLIENT_SECRET&redirect_uri=http%3A%2F%2Flocalhost&grant_type=authorization_code&code=AUTH_CODE'
```
4) obtain access_token and refresh_token from the response body
5) create a file named `twitch.tokens.json` with the following content:
```json
{
  "accessToken": "ACCESS_TOKEN",
  "refreshToken": "REFRESH_TOKEN",
  "scope": [],
  "expiresIn": 1000,
  "obtainmentTimestamp": 0
}
```