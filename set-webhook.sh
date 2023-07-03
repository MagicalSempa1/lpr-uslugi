TOKEN=$(jq '.TELEGRAM_BOT_TOKEN' secrets.json --raw-output)
jq '{url: "https://lpr-uslugi.antender.workers.dev/lpr-uslugi-bot", allowed_updates: "[\"message\"]", drop_pending_updates: true, secret_token: .TELEGRAM_HEADER_SECRET}' secrets.json |
curl "https://api.telegram.org/bot$TOKEN/setWebhook" -X POST -H 'content-type: application/json' -d @-