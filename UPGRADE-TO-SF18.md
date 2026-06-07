# Upgrade to Stockfish 18

## ✅ Current Status
You are now running **Stockfish 18** (released January 31, 2026)

## 🚀 What's New in Stockfish 18

### Performance Improvements
- **~100 Elo stronger** than Stockfish 16
- Enhanced NNUE evaluation with larger network
- Faster search algorithm optimizations
- Better endgame play

### Technical Changes
- Larger NNUE network (file size: 108MB vs 65MB in SF16)
- Improved position evaluation
- Better time management in rapid/blitz
- Enhanced multi-threading performance

## 📥 How to Manually Upgrade (If Needed)

If you need to reinstall or upgrade on another machine:

### Step 1: Download Stockfish 18
```
https://github.com/official-stockfish/Stockfish/releases/download/sf_18/stockfish-windows-x86-64-avx2.zip
```

### Step 2: Extract the ZIP
Extract the contents to:
```
Chess-Automation-Engine\stockfish-bin\
```

The final structure should be:
```
Chess-Automation-Engine\
├── stockfish-bin\
│   └── stockfish\
│       ├── stockfish-windows-x86-64-avx2.exe  ← The engine
│       ├── AUTHORS
│       ├── README.md
│       └── ... (other files)
```

### Step 3: Verify Installation
Run the server:
```bash
cd artifacts\chess-advisor
start-server.bat
```

You should see:
```
✅ Found Stockfish at: ...\stockfish-windows-x86-64-avx2.exe
🚀 Starting Stockfish...
✅ Stockfish ready
```

## 🔍 Verify Your Version

To check which version you're running:

**PowerShell:**
```powershell
echo "quit" | .\stockfish-bin\stockfish\stockfish-windows-x86-64-avx2.exe
```

**CMD:**
```cmd
echo quit | stockfish-bin\stockfish\stockfish-windows-x86-64-avx2.exe
```

Output should show:
```
Stockfish 18 by the Stockfish developers (see AUTHORS file)
```

## 📊 Performance Comparison

| Version | Elo Rating | Release Date | File Size |
|---------|------------|--------------|-----------|
| SF 16   | ~3600      | Jul 2023     | 65 MB     |
| SF 17   | ~3670      | Jan 2024     | 75 MB     |
| SF 18   | ~3705      | Jan 2026     | 108 MB    |

## ⚙️ System Requirements

- **CPU**: x86-64 with AVX2 support (most CPUs since 2013)
- **RAM**: 256MB minimum (default hash size)
- **Disk**: 150MB free space
- **OS**: Windows 7 or later

## 🐛 Troubleshooting

### "Stockfish not found"
- Verify the exe is at: `stockfish-bin\stockfish\stockfish-windows-x86-64-avx2.exe`
- Check file size: should be ~108MB
- Try re-downloading if corrupt

### "Access denied" errors
- Close any running Stockfish processes:
  ```powershell
  taskkill /F /IM stockfish-windows-x86-64-avx2.exe
  ```
- Make sure antivirus isn't blocking it

### Server won't start
- Check port 8765 isn't in use
- Verify Node.js is installed
- Run `npm install` in the server folder

## 📝 Notes

- Stockfish binaries are excluded from git due to GitHub's 100MB file limit
- Download directly from official Stockfish releases
- The server auto-detects Stockfish in multiple locations
- No configuration changes needed - upgrade is transparent

## 🔗 Links

- [Stockfish Official](https://stockfishchess.org/)
- [Stockfish GitHub Releases](https://github.com/official-stockfish/Stockfish/releases)
- [Stockfish Documentation](https://github.com/official-stockfish/Stockfish/wiki)

---

**You're all set with Stockfish 18!** 🎉
