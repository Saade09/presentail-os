# Presentail OS web

## Google Maps browser key

Address Book place pins use the Google Maps JavaScript API. Set
`VITE_GOOGLE_MAPS_BROWSER_KEY` for the web artifact build. It is a browser key,
so it is intentionally included in the client bundle; do not use a server key.

In Google Cloud Console, enable only **Maps JavaScript API** for this key and
add HTTP referrer restrictions for the allowed OS origins, including:

- `https://os.presentail.com/*`
- the approved Replit development/preview origin patterns for this artifact
- any explicitly approved custom OS domains

Do not use an unrestricted key or wildcard unrelated domains. If no key is
configured, blocked by referrer restrictions, or the Maps script cannot load,
the Address Book keeps working with a coordinate display and an external Google
Maps link instead of blanking the page.