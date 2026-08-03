# AardClient for Android

The same client as `pwa/`, with the relay built in.

In a browser the client cannot open a raw TCP socket, so `relay_minimal.py` on a
PC at home holds the telnet session to `aardwolf.org:4000` and bridges it over a
WebSocket. An Android app can open that socket itself — so this build needs no
relay, no WSL bridge, no Cloudflare tunnel and no machine left running.

## How it fits together

```
MainActivity   WebView + WebViewAssetLoader  ->  serves pwa/ over https://appassets.androidplatform.net
   |                                             (a file:// origin would break IndexedDB and ES modules)
   |  window.AardNative  <->  pwa/js/transport.js
   v
MudService     foreground service, owns the connection, survives the Activity
   |
   v
TelnetSession  TCP + telnet IAC + GMCP  ->  the same JSON the relay emits
```

`pwa/` is **not** copied in. `app/build.gradle.kts` adds `../pwa` as an assets
source directory, so the app always builds whatever the browser client currently
is. Edit `pwa/js/snd.js` and the next app build has the change.

## Building

Requires the **Android SDK** (platform 33 + build-tools). Java is already
covered: use the JDK bundled with Android Studio (`jbr`, 17.0.6).

### With Android Studio

1. `File > Open` → `D:\projects\aardwolf-pwa\android`
2. If the SDK is missing, Studio offers to download it — accept.
3. `Build > Build Bundle(s) / APK(s) > Build APK(s)`
4. The APK lands in `app/build/outputs/apk/debug/app-debug.apk`

Versions are pinned to what Android Studio 2022.2 (Flamingo) accepts: **AGP
8.0.2, Gradle 8.0.2, Kotlin 1.8.22, compileSdk 33**. AGP 8.1+ refuses to sync
there, so do not bump these without upgrading Studio too.

### From the command line

Needs `local.properties` pointing at the SDK:

```properties
sdk.dir=C\:\\Users\\rama\\AppData\\Local\\Android\\Sdk
```

Then:

```
gradlew.bat assembleDebug
```

(The Gradle wrapper JAR is not committed; Studio regenerates it, or run
`gradle wrapper` once with a local Gradle 8.0.2.)

## Installing

`adb install -r app/build/outputs/apk/debug/app-debug.apk`, or copy the APK to
the phone and open it (needs "install unknown apps" for the file manager).

The debug APK is signed with the local debug key. That is fine for personal use;
it is not upgradeable-in-place from a differently-signed build, so uninstall
first if you ever switch to a release key.

## Moving your existing data across

The app starts with an empty map database — browser storage is per-origin and
cannot be shared. To bring across months of mapping, aliases, triggers and
shortcut buttons:

1. In the browser client: `/export` → saves `aardmap-YYYY-MM-DD.db`
2. Get that file onto the phone
3. In the app: `/import` → pick it

`gaardian_maps.db` ships inside the APK, so the 269-area reference map is there
from the first launch.

## Behaviour that differs from the PWA

| | PWA + relay | Android app |
|---|---|---|
| Session survives closing the client | yes, on the PC | yes, while the service runs |
| Session survives the **phone** being off | yes | no |
| Same session on phone *and* desktop | yes | no, local only |
| Needs a machine running at home | yes | no |

The MUD session lives in a foreground service with an ongoing notification, and
holds a partial wake lock while connected — a MUD connection is a long-lived TCP
socket with long idle gaps, which is exactly what Doze tears down. Ending the
session is the notification's **Disconnect** action; closing the app only hides
the window, so you do not go link-dead by switching apps mid-campaign.

Battery: the wake lock only exists while connected. Disconnect when you are done.

## Debugging

Debug builds enable WebView inspection: connect the phone by USB and open
`chrome://inspect` on the PC. The JS console also mirrors to logcat under the
`AardClient` tag.
