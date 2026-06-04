# 🚀 Quick Start Guide

## Step 1: Download Stockfish (1 minute)

1. **Download Stockfish 16** from: https://github.com/official-stockfish/Stockfish/releases/download/sf_16/stockfish-windows-x86-64-avx2.zip

2. **Extract the ZIP file**

3. **Copy `stockfish-windows-x86-64-avx2.exe`** to one of these locations:
   - `C:\Users\ozodq\Downloads\Chess-Automation-Engine\artifacts\chess-advisor\server\stockfish.exe` ⭐ EASIEST
   - `C:\Program Files\Stockfish\stockfish.exe`
   - Or anywhere in your system PATH

## Step 2: Start the Server

Double-click: `start-server.bat`

You should see:
```
✅ Found Stockfish at: ...
✅ Stockfish ready
✅ Server listening on http://localhost:8765
```

## Step 3: Load Extension in Browser

### Chrome/Edge:
1. Open `chrome://extensions/` (or `edge://extensions/`)
2. Turn ON "Developer mode" (top right)
3. Click "Load unpacked"
4. Select folder:
   - `extension` for chessfriends.com
   - `extension-chesscom` for chess.com

### Firefox:
1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `manifest.json` from extension folder

## Step 4: Play Chess! ♟️

1. Go to chessfriends.com or chess.com
2. Start a game
3. You'll see glowing arrows showing the best moves!

---

## Troubleshooting

**"Stockfish not found"**
→ Download from link above and copy to `server\stockfish.exe`

**Server won't start**
→ Make sure no other program is using port 8765

**No moves showing**
→ Check browser console (F12) for errors
→ Make sure server is running

**Direct download link:** https://github.com/official-stockfish/Stockfish/releases/download/sf_16/stockfish-windows-x86-64-avx2.zip
