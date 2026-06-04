# Chess Advisor - Browser Extension

Real-time chess move suggestions powered by Stockfish engine.

## 🎯 Features

- **Visual move overlay** - Shows best moves directly on the chessboard
- **Supports multiple sites**:
  - chessfriends.com (extension folder)
  - chess.com (extension-chesscom folder)
- **Smart time management** - Adapts thinking time based on game situation
- **Premove support** - Suggests premoves for obvious opponent responses

## 📦 Setup

### 1. Install Stockfish

**Option A - Download from official site:**
```bash
cd server
setup-stockfish.bat
```

This will open the Stockfish download page. Download and install to:
- `C:\Program Files\Stockfish\stockfish.exe`, or
- Add to your system PATH

**Option B - Manual download:**
1. Go to https://stockfishchess.org/download/
2. Download: `stockfish-windows-x86-64-avx2.zip`
3. Extract and place `stockfish.exe` in a known location
4. Add to PATH or place in `C:\Program Files\Stockfish\`

### 2. Install Server Dependencies

```bash
cd server
npm install
```

### 3. Start the Server

```bash
start-server.bat
```

Or manually:
```bash
node stockfish-server.mjs
```

The server runs on `http://localhost:8765`

### 4. Load the Extension

**For Chrome/Edge:**
1. Open `chrome://extensions/` or `edge://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extension` folder (for chessfriends) or `extension-chesscom` folder

**For Firefox:**
1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `manifest.json` from the extension folder

## 🎮 Usage

1. Make sure the server is running (you'll see "✅ Stockfish ready")
2. Open chessfriends.com or chess.com
3. Start a game
4. The extension will show:
   - Green circle on the FROM square
   - Yellow circle on the TO square
   - Arrow showing the move
   - Corner notification with move in algebraic notation

## 🛠️ Troubleshooting

**Server won't start - "Stockfish not found"**
- Run `setup-stockfish.bat` to download Stockfish
- Or manually install to `C:\Program Files\Stockfish\`

**Extension not working**
- Check that the server is running on port 8765
- Open browser console (F12) and check for errors
- Make sure you're on a supported chess site

**Moves not showing**
- Server might be thinking - wait a moment
- Check server console for errors
- Refresh the chess page

## 🔧 Configuration

Edit `stockfish-server.mjs` to customize:
- **PORT** - Change server port (default: 8765)
- **Skill Level** - Adjust engine strength (default: 20/max)
- **Threads** - CPU threads to use (default: 4)
- **Hash** - Memory for engine (default: 256MB)

## 📁 Project Structure

```
chess-advisor/
├── extension/              # Extension for chessfriends.com
│   ├── manifest.json      # Extension config
│   ├── background.js      # Background worker
│   ├── content.js         # Page script injector
│   ├── inject.js          # Main logic
│   ├── popup.html         # Extension popup UI
│   └── popup.js           # Popup controls
├── extension-chesscom/    # Extension for chess.com (same structure)
├── server/
│   ├── stockfish-server.mjs  # HTTP server + Stockfish wrapper
│   ├── setup-stockfish.bat   # Auto-download helper
│   └── package.json
└── start-server.bat       # Quick start script
```

## ⚖️ Legal & Fair Play

This tool is for **educational and practice purposes only**. Using chess engines during competitive games against other players violates fair play policies on all major chess platforms and is considered cheating.

**Use responsibly:**
- ✅ Analysis of your own games
- ✅ Practice and training
- ✅ Playing against bots
- ❌ Ranked/rated games against humans
- ❌ Tournaments
- ❌ Any competitive play

## 📝 License

This project is for educational purposes. Stockfish is licensed under GPL v3.
