# Chess Advisor - Complete Feature List

Both extensions now have **full feature parity** with identical functionality.

## 🎯 Core Features

### Visual Overlay System
- ✅ **Glowing Arrows** - Shows best move from square to square
- ✅ **Color-Coded Circles**
  - 🟢 Green circle on FROM square
  - 🟡 Yellow circle on TO square
- ✅ **Move Label** - Displays move in UCI notation
- ✅ **Pulsing Animation** - Attention-grabbing visual effect
- ✅ **Corner Notification** - Large move display in top-right corner

### Move Execution
- ✅ **Multiple Strategies** for maximum compatibility:
  1. Chessground API direct calls (`cg.move()`, `cg.selectSquare()`)
  2. Platform-specific methods (panel.userMove, etc.)
  3. CDP trusted clicks (Chrome DevTools Protocol)
  4. Drag-and-drop simulation with pointer events
  5. Fallback click-to-move
- ✅ **Precise Coordinates** - Uses actual piece DOM elements for accuracy
- ✅ **Promotion Handling** - Automatic queen/rook/bishop/knight selection
- ✅ **Move Verification** - Tracks piece positions before/after

### Time Management

#### Auto Mode (Clock-Based)
- ✅ **Smart Allocation** - Adapts to remaining time
- ✅ **Position Complexity Detection**
  - Forced moves: 0-50ms extra think
  - Easy positions (gap ≥200cp): 50ms
  - Clear positions (gap ≥80cp): 150ms
  - Normal positions (gap ≥30cp): 400ms
  - Critical positions (gap <30cp): 800ms
- ✅ **Reserve Time** - Always keeps 5000ms buffer (3000ms in bullet)
- ✅ **Safety Cap** - Never spends more than 1/5 of remaining time

#### Bullet Mode
- ✅ **Fast Polling** - 100ms intervals (vs 200ms normal)
- ✅ **Reduced Think Times** - Tighter complexity ladder
- ✅ **Quick Clicks** - Minimal delays between moves
- ✅ **Shorter Timeouts** - 800ms move verification (vs 3000ms)
- ✅ **Optimized Premoves** - More aggressive threshold (100cp vs 200cp)

#### Manual Mode
- ✅ **Forced Movetime** - User sets exact think duration (0-5000ms)
- ✅ **Override Safety** - Still respects 1/5 cap to prevent flag

### Advanced Features

#### Premove System
- ✅ **Opponent Prediction** - Multi-PV analysis of likely responses
- ✅ **Confidence Scoring** - Only premoves "obvious" positions:
  - Only-move (100% confidence)
  - Forced mate (95%)
  - Large eval gap (70-95% based on gap)
  - Recapture (80% if gap ≥30cp)
- ✅ **Auto-Execution** - Queues premove for instant play
- ✅ **Validation** - Cancels if opponent plays differently

#### Repetition Detection
- ✅ **Position Tracking** - Remembers last 10 positions
- ✅ **Think-Time Boost** - Forces deeper search on repetitions:
  - 1st repetition: +250ms
  - 2nd repetition: +600ms
- ✅ **Draw Avoidance** - Prevents 3-fold repetition in winning positions

#### Auto-Play Safety
- ✅ **Move Throttling** - 700ms between moves (350ms bullet)
- ✅ **Click Retry** - Up to 2 retries if piece doesn't move
- ✅ **FEN Verification** - Confirms position before each move
- ✅ **Animation Detection** - Skips corrupt mid-animation reads
- ✅ **Duplicate Prevention** - Never analyzes same position twice

### Board Detection

#### Multi-Platform Support
- ✅ **Chessground** (chessfriends.com, lichess)
- ✅ **Chess.com custom elements** (wc-chess-board)
- ✅ **Square-based systems** (chess.com square-NN classes)
- ✅ **Generic detection** - Largest square element fallback

#### FEN Extraction
- ✅ **DOM-Based Reading** - Direct from piece elements
- ✅ **Multiple Methods**:
  - Chess.com square-NN classes (most reliable)
  - Chessground positional
  - Piece bounding rect analysis
- ✅ **Orientation Detection**
  - Class-based (orientation-black/white)
  - Attribute-based (flipped attr)
  - King position fallback
- ✅ **Corruption Detection** - Rejects mid-animation FENs

#### Clock Reading
- ✅ **Time Display Detection** - Finds mm:ss patterns
- ✅ **Font-Size Scoring** - Prioritizes large player clocks
- ✅ **Class-Based Hints** - Prefers elements with "clock" class
- ✅ **Position Mapping** - Top = opponent, bottom = player

## 🎮 User Interface

### Controls
- ✅ **Advise Toggle** - Enable/disable automatic suggestions
- ✅ **Auto-Play Toggle** - Enable/disable automatic move execution
- ✅ **Premove Toggle** - Enable/disable premove calculation
- ✅ **Bullet Mode Toggle** - Switch to fast timings
- ✅ **Movetime Slider** - Set custom think time (0-5000ms)
- ✅ **Keyboard Shortcuts** - Quick access via hotkeys

### Status Display
- ✅ **Corner Status** - Real-time engine state
- ✅ **Progress Messages**:
  - "Reading board..."
  - "Thinking..."
  - "🤖 Playing [MOVE]"
  - "⏩ Premove: [MOVE] if opp [MOVE]"
- ✅ **Error Messages** - Clear problem descriptions
- ✅ **Auto-Hide** - Messages disappear after 2-6 seconds

### Visual Feedback
- ✅ **Color-Coded Buttons**
  - Green = Active
  - Gray = Inactive
- ✅ **Opacity States** - Disabled features shown at 50%
- ✅ **Tooltips** - Explains why features are disabled

## 🛠️ Technical Details

### Performance
- ✅ **Non-Blocking** - Uses async/await throughout
- ✅ **Debouncing** - Prevents duplicate requests
- ✅ **Throttling** - Limits click frequency
- ✅ **Timeouts** - All network calls have 20s limit
- ✅ **Abort Controllers** - Clean cancellation

### Error Handling
- ✅ **Graceful Degradation** - Falls back through strategies
- ✅ **Corruption Detection** - Skips bad FEN reads
- ✅ **Network Resilience** - Clear error messages
- ✅ **Auto-Recovery** - Clears stuck states

### Logging
- ✅ **Tagged Console Output** - All logs prefixed with `[CA]`
- ✅ **Diagnostic Mode** - Detailed board inspection
- ✅ **Move Tracking** - Logs every decision
- ✅ **Timing Info** - Shows think times and delays

## 📊 Feature Comparison

| Feature | Chessfriends.com | Chess.com |
|---------|------------------|-----------|
| Visual Arrows | ✅ | ✅ |
| Auto-Play | ✅ | ✅ |
| Premove | ✅ | ✅ |
| Bullet Mode | ✅ | ✅ |
| Smart Time | ✅ | ✅ |
| CDP Clicks | ✅ | ✅ |
| Repetition Detection | ✅ | ✅ |
| Clock Reading | ✅ | ✅ |
| Move Retry | ✅ | ✅ |
| FEN Verification | ✅ | ✅ |

**Result: 100% Feature Parity** ✅

## 🚀 Usage Tips

### For Best Results:
1. Start with **Advise Only** mode to learn
2. Enable **Auto-Play** when comfortable
3. Use **Bullet Mode** for 1-minute games
4. Enable **Premove** for maximum speed
5. Adjust **Movetime** based on your internet speed

### Troubleshooting:
- If moves don't execute → Check browser console for errors
- If arrows don't appear → Refresh the page and reload extension
- If server errors → Make sure `start-server.bat` is running
- If positions repeat → Repetition detection should handle it

## 📝 Notes

- Both extensions share the same codebase for content.js, popup, and background
- The only differences are in inject.js (site-specific board detection)
- All advanced features work identically on both platforms
- Server API supports all features (premove, smart time, bullet mode, etc.)
