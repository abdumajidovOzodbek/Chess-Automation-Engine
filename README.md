# Chess Automation Engine

Real-time chess assistance powered by Stockfish 16. Visual overlay system that shows best moves directly on your chessboard.

## ✨ Features

- 🎯 **Visual Move Overlay** - Glowing arrows showing best moves
- ⚡ **Real-time Analysis** - Stockfish 16 at maximum strength
- 🌐 **Multi-platform** - Works on chessfriends.com and chess.com
- 🧠 **Smart Time Management** - Adapts thinking time to game complexity
- 🎨 **Clean UI** - Non-intrusive visual indicators

## 🚀 Quick Start (3 steps)

### 1. Start the Stockfish Server

```bash
cd artifacts/chess-advisor
start-server.bat
```

You should see:
```
✅ Found Stockfish
✅ Stockfish ready
✅ Server listening on http://localhost:8765
```

**Note:** Stockfish is already included! No download needed.

### 2. Load Browser Extension

**Chrome/Edge:**
1. Go to `chrome://extensions/` or `edge://extensions/`
2. Enable "Developer mode" (top right toggle)
3. Click "Load unpacked"
4. Select folder:
   - `artifacts/chess-advisor/extension` for chessfriends.com
   - `artifacts/chess-advisor/extension-chesscom` for chess.com

**Firefox:**
1. Go to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `manifest.json` from the extension folder

### 3. Play Chess! ♟️

1. Visit chessfriends.com or chess.com
2. Start a game
3. Watch the glowing arrows guide your moves!

## 📁 Project Structure

```
Chess-Automation-Engine/
├── artifacts/
│   ├── chess-advisor/         # Browser extensions + server
│   │   ├── extension/         # Extension for chessfriends.com
│   │   ├── extension-chesscom/# Extension for chess.com
│   │   ├── server/            # Stockfish HTTP server
│   │   ├── README.md          # Full documentation
│   │   └── QUICKSTART.md      # Quick setup guide
│   ├── api-server/            # Main API server
│   └── chess-ui/              # Web UI dashboard
├── stockfish-bin/             # Stockfish 16 binary (included)
└── README.md                  # This file
```

## 🎮 How It Works

1. **Server** runs Stockfish locally on port 8765
2. **Extension** injects into chess websites
3. **Analysis** happens in real-time as the game progresses
4. **Overlay** shows:
   - 🟢 Green circle on FROM square
   - 🟡 Yellow circle on TO square  
   - ➡️ Arrow showing the move path
   - 🏷️ Corner label with move notation

## 🔧 Configuration

The server is pre-configured with optimal settings:
- **Skill Level:** 20 (maximum)
- **Threads:** 4
- **Hash Memory:** 256 MB
- **Depth:** 16-20 depending on time control

Edit `artifacts/chess-advisor/server/stockfish-server.mjs` to customize.

## 📚 Documentation

- **Full Setup Guide:** `artifacts/chess-advisor/README.md`
- **Quick Start:** `artifacts/chess-advisor/QUICKSTART.md`
- **API Documentation:** `artifacts/api-server/README.md` (if exists)

## 🛠️ Troubleshooting

**Server won't start**
- Check if port 8765 is available
- Make sure Stockfish binary exists in `stockfish-bin/stockfish/`

**Extension not working**
- Verify server is running (check console output)
- Open browser DevTools (F12) and check for errors
- Try reloading the chess website

**No arrows showing**
- Extension might be loading - wait 2-3 seconds
- Check that you're on a supported site (chessfriends.com or chess.com)
- Make sure it's your turn to move

## ⚖️ Legal & Ethics

**⚠️ IMPORTANT:** This tool is for **educational and practice purposes ONLY**.

Using chess engines during competitive games violates fair play policies and is considered cheating.

**Acceptable Use:**
- ✅ Analyzing your completed games
- ✅ Studying positions and tactics
- ✅ Practice against computer opponents
- ✅ Learning and training

**NOT Acceptable:**
- ❌ Rated/ranked games against humans
- ❌ Tournaments
- ❌ Competitive matchmaking
- ❌ Any form of online competitive play

**Using this tool in competitive play will result in account bans.**

## 📄 License

This project is for educational purposes. Stockfish is licensed under GPL v3.

## 🤝 Contributing

Feel free to open issues or submit pull requests for improvements!

## 🙏 Credits

- **Stockfish** - The powerful open-source chess engine
- Built with Playwright, Node.js, and vanilla JavaScript
