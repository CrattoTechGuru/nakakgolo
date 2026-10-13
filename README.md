# NakaKgolo (Android)

The full NakaKgolo app, running in an Android app with a floating window that stays above other apps.
The web app in `app/src/main/assets/` is the installable build, with one addition: the Settings
"Enable Floating Window" button opens the native floating window when running in this Android app.

## Build (GitHub)

Upload this folder to a GitHub repository. The workflow in `.github/workflows/build-apk.yml` builds
the APK. Download **NakaKgolo-debug-apk** from the Actions run.

## Use

1. Open NakaKgolo. It runs full screen.
2. Go to **Settings → Enable Floating Window**.
   - The first time, Android asks you to allow display over other apps for NakaKgolo. Turn it on, go back, and tap the button again.
3. The app minimises and a small NakaKgolo window floats above your other apps.
   - Drag the top bar to move it, drag the blue ◢ corner to resize it.
   - Tap ⤢ to return to the full-screen app. The notification's **Open app** does the same.
4. Pressing Back in the full-screen app sends it to the background and keeps your session.

## Notes

- The floating window and the full-screen app are the same running app, so your login and current session carry over.
- The app's data is stored on the phone in the app's own storage. It is separate from the installed PWA.
- Not compiled or tested on a device yet.
