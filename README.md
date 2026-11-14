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
npm run dist:win   # build a Windows installer (run on Windows)
```

The GitHub Actions workflow in `.github/workflows/build.yml` builds both installers on every `v*` tag,
or on demand from the Actions tab.

**Signing:** without an Apple Developer ID the Mac app is unsigned, so the first launch needs
right-click → Open (or System Settings → Privacy & Security → Open Anyway). Add the secrets named in
the workflow to sign and notarize it so it opens normally for everyone.

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
