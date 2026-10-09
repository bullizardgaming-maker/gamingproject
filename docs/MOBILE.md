# App-store versions

The web app is already installable (PWA: manifest, icons, service worker, offline page). These steps wrap it for
Google Play and the App Store. They need your developer accounts and signing keys, so none of it can be finished
from the repository alone.

**Read the store payment rules first (section 3).** Both stores restrict selling digital goods inside apps. Game
accounts, items, currency and keys are digital goods, so a store version may need its checkout changed or removed.
Get that decided (ideally with legal advice) before you submit.

## 1. Android: Trusted Web Activity

A Trusted Web Activity runs the live site full-screen in Chrome, with no browser bar, once the site proves it
trusts the app. Updates to the site reach the app straight away; there is no separate app code.

1. Create a Google Play developer account and an app with package name `com.bullizard.app` (or your own; set
   `ANDROID_PACKAGE_ID` to match).
2. In `mobile/android/twa-manifest.json`, replace `app.example.com` with the production web domain.
3. Install Bubblewrap (`npm i -g @bubblewrap/cli`, needs a JDK and the Android SDK, which it can download), then in
   `mobile/android`: `bubblewrap build`. The first run creates the upload key (`bullizard-upload.keystore`): keep
   it and its password safe and out of the repository.
4. Upload the `.aab` to Play Console. With Play App Signing, copy the **app signing key** SHA-256 fingerprint from
   Play Console → Setup → App integrity.
5. Set `ANDROID_CERT_SHA256` to that fingerprint in the web build environment (Vercel or the Docker build) and
   redeploy. The build then publishes `/.well-known/assetlinks.json`; until it does, the app shows a browser bar.
6. Check: `https://<domain>/.well-known/assetlinks.json` lists the fingerprint, and Google's
   [Statement List tester](https://developers.google.com/digital-asset-links/tools/generator) passes.

Push notifications keep working: the app uses the site's Web Push (enable notifications is on in the manifest).

## 2. iOS: Capacitor shell

iOS has no Trusted Web Activity. `mobile/ios/capacitor.config.json` is a starting point for a Capacitor app that
loads the live site (so sign-in cookies stay first-party and the site's updates apply at once).

1. On a Mac with Xcode: create a Capacitor project in `mobile/ios` (`npm init -y`, `npm i @capacitor/core
   @capacitor/cli @capacitor/ios`), copy `www-index.html` to `www/index.html`, replace `app.example.com` in the
   config, then `npx cap add ios` and `npx cap open ios`.
2. Set the bundle id (`com.bullizard.app`) and your team in Xcode; add the Associated Domains capability with
   `applinks:<domain>`.
3. Set `APPLE_TEAM_ID` (and `IOS_BUNDLE_ID` if different) in the web build environment and redeploy. The build
   publishes `/.well-known/apple-app-site-association`, so listing, order, shop, game and request links open
   in the app. It is served as `application/json` (Vercel and nginx configs included).

Known gaps on iOS, to plan before submitting:
- **Push:** Web Push doesn't reach a Capacitor app; it needs Apple Push Notification service via a Capacitor
  plugin and a server-side sender.
- **Review guideline 4.2 (minimum functionality):** Apple rejects apps that are only a website in a frame. Native
  features (push, share sheet, biometric unlock) help make the case.

## 3. Store payment rules

- **Google Play** requires its own billing for most in-app sales of digital goods, with exceptions and
  alternative-billing programmes that vary by country.
- **Apple** requires in-app purchase for digital content used in the app (guideline 3.1.1); rules on linking out
  to web checkout differ by country and have been changing.

Options to weigh with legal advice: a store version for browsing, chat, orders and selling with purchases
completed on the website where the rules allow it; using store billing for card purchases (store fees apply on
top of commission); or staying web-only (the installable PWA) in regions where the rules don't fit. The store builds open the
site with `?source=twa` / `?source=ios`, which the web app can use to switch the checkout once the decision is made.
