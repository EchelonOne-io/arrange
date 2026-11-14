# Home Screen Organizer

A desktop app (Mac and Windows) for rearranging your iPad or iPhone Home Screen from your computer over USB.
It detects which one is plugged in and shows its real grid: 6 × 5 pages on an iPad, 4 × 6 pages and a
4-item Dock on an iPhone.

- Drag icons between pages, the dock, folders and a parking **Shelf**
- Select several apps to make a folder or move them together; rename and sort folders
- **Remove apps from the Home Screen** (they stay installed, in the App Library), or add App-Library-only apps back
- Sort a page or everything A–Z, undo/redo, search
- Nothing changes until you press **Apply to iPad**. A backup is saved first, in
  `Documents/Home Screen Organizer Backups`, and **Backups** restores any of them
  (backups from when the app was called iPad Organizer are moved there on first launch)

Try it without a device: click **Try it with a sample device** and pick the sample iPad or iPhone.

## For people using it

1. Install and open Home Screen Organizer.
2. Plug the iPad in with a cable and unlock it.
3. First time only: on a Mac, open Finder, click the iPad in the sidebar and choose **Trust**, then tap
   **Trust** on the iPad. On Windows, install the **Apple Devices** app from the Microsoft Store first.
4. The Home Screen appears. Rearrange, then press **Apply to iPad**.

## For developers

```
npm install
npm start          # run the app
npm run demo       # run with the sample iPad
npm test           # unit tests
npm run dist:mac   # build a .dmg (run on a Mac)
npm run dist:mac:signed  # build a signed + notarized .dmg (see Signing below)
npm run dist:win   # build a Windows installer (run on Windows)
```

**Releasing:** on GitHub, go to Releases → **Draft a new release**, create a tag like `v1.2.0`, and
publish. The workflow in `.github/workflows/build.yml` builds, signs and notarizes the Mac app, uses the tag
as the app version, and attaches the .dmg to the release in about 5 minutes. The newest release is always at:

https://github.com/EchelonOne-io/iorg/releases/latest/download/Home-Screen-Organizer.dmg

Running the workflow from the Actions tab builds the same .dmg as a downloadable artifact without
releasing anything. CI does not build Windows; build that yourself as below.

**Building for Windows:** run these on a Windows PC with [Node.js 22](https://nodejs.org) and Git installed:

```powershell
git clone https://github.com/EchelonOne-io/iorg.git
cd iorg
npm ci
npm test
npm run dist:win
```

The installer lands in `dist\Home Screen Organizer Setup <version>.exe`. It is unsigned, so on first run
Windows SmartScreen shows a warning: click **More info → Run anyway**. To sign it, get a Windows
code-signing certificate (.pfx) and set `CSC_LINK` (path to the .pfx) and `CSC_KEY_PASSWORD` before
`npm run dist:win`. The Apple certificate does not work for Windows. To use the app, the PC also needs the
**Apple Devices** app from the Microsoft Store, which provides the USB connection to the iPhone or iPad.

**Signing:** an unsigned Mac app needs right-click → Open on first launch. To sign and notarize it so it
opens normally for everyone, use a **Developer ID Application** certificate (from developer.apple.com →
Certificates; it must be in your login keychain). The app is built with the hardened runtime and the
entitlements in `build/entitlements.mac.plist`.

*On your Mac*, once, save notarization credentials in the keychain (needs an app-specific password from
account.apple.com → Sign-In and Security):

```bash
xcrun notarytool store-credentials hso-notary --apple-id you@example.com --team-id YOURTEAMID
```

Then `npm run dist:mac:signed` signs with the Developer ID in your keychain and notarizes the app.
Use `APPLE_KEYCHAIN_PROFILE=other-name` to pick a different saved profile.

*In GitHub Actions*, add these repository secrets: `MAC_CERT_P12_BASE64` (the certificate and its private
key exported from Keychain Access as a .p12, then `base64 -i cert.p12 | pbcopy`), `MAC_CERT_PASSWORD`,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. Without them the workflow builds unsigned.

### How it works

- `src/device.js` talks to the iPad through Apple's usbmuxd (built into macOS; included with the Apple
  Devices app on Windows) using `appium-ios-device` for the lockdown handshake, then speaks the
  SpringBoard services protocol (`getIconState`, `setIconState`, `getIconPNGData`), the same channel
  iTunes once used to arrange apps.
- `src/bplist.js` is a lossless binary-plist codec. SpringBoard timestamps have sub-millisecond
  precision, and recent iPadOS versions reject layouts whose timestamps were rounded, so dates are kept
  as raw seconds rather than JavaScript Dates.
- `src/profile.js` picks the Home Screen shape (grid, Dock limit, wording) from the device's model
  (`ProductType`, e.g. `iPhone17,1` or `iPad14,3`).
- `src/layout.js` turns the layout into a simple tree for the interface and back, keeping every item
  it does not understand (widgets, stacks, new fields) exactly as the iPad sent it.
- After every apply, the app reads the layout back and reports whether the iPad kept it.

### Limits

- Widgets show as grey blocks: movable between pages, not editable.
- Apple does not document this protocol, so a future iPadOS update could change what it accepts.
- Not yet tested on a real iPad or iPhone.
