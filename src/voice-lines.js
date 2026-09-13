// voice-lines.js — every line Yui can speak out loud.
//
// These are SPOKEN lines, which is why none of them contain a ticker or a dollar
// amount: the clips are generated once (scripts/gen-voice.js) and shipped as mp3,
// so anything that changes per trade has to stay in the speech bubble instead.
// She says "Ooh, nice pick! Good luck~" while the bubble reads "Ooh, BONK! $50 in."
//
// id -> text. The id is also the filename: sounds/voice/<id>.mp3
// Regenerate after editing: `npm run voice`  (only changed lines are re-billed)

export const VOICE_LINES = {
  // ---- greetings / panel
  'greet-1':      "Hi! I'm Yui.",
  'greet-2':      "Yui here. Need something?",
  'greet-3':      "Ehehe, hello!",
  'greet-4':      "Un! I'm watching.",

  // ---- connected to the relay
  'connect-1':    "Connected! I'm watching your wallet now.",
  'connect-2':    "Okay, I can see your trades. Let's go.",

  // ---- a buy landed
  'buy-1':        "Ooh, nice pick! Good luck.",
  'buy-2':        "New position. I'm watching it with you!",
  'buy-3':        "Hmm... interesting choice.",
  'buy-4':        "In we go. Let's go!",

  // ---- sold at a profit
  'profit-1':     "Nice trade!",
  'profit-2':     "It paid out!",
  'profit-3':     "You did it!",
  'profit-4':     "Ehehe, look at that.",
  'profit-5':     "Clean. Really clean.",

  // ---- sold at a big profit
  'bigprofit-1':  "Waaa! That's huge!",
  'bigprofit-2':  "That's huge! Oh my gosh!",
  'bigprofit-3':  "You're amazing!",
  'bigprofit-4':  "No way! No way, no way!",

  // ---- sold at a loss (soft, never mocking)
  'loss-1':       "It's okay... only a little. Next one.",
  'loss-2':       "That was a bad one. You're still good.",
  'loss-3':       "Mm... I'm here, okay?",
  'loss-4':       "Losses happen. Breathe.",
  'loss-5':       "Don't chase it. Please?",

  // ---- sold at a big loss (she gets quiet and kind)
  'bigloss-1':    "Come here. It's going to be fine.",
  'bigloss-2':    "That hurt. Take a break, I'll wait here.",
  'bigloss-3':    "It's just one trade. You're not.",

  // ---- closed flat
  'flat-1':       "Flat. Clean exit.",
  'flat-2':       "Even. No harm done.",
  'flat-3':       "Closed. That's fine.",

  // ---- being picked up, thrown, dropped
  'grab-1':       "Hyaa!",
  'grab-2':       "Waah, hey!",
  'throw-1':      "Kyaaa!",
  'throw-2':      "Wheeee!",
  'land-1':       "Oof!",
  'land-2':       "Ah! I'm okay!",
  'dizzy-1':      "Uuu... everything's spinning...",
  'dizzy-2':      "Too much... too much...",

  // ---- idle
  'idle-1':       "Mm... still watching.",
  'idle-2':       "Everything's quiet right now.",
  'idle-3':       "Hmmm hmm hmm...",
  'stretch-1':    "Fuaaah... sleepy.",
  'jump-1':       "Hup!",
  'cheerup-1':    "Ganbatte! You've got this.",
  'cheerup-2':    "I believe in you, okay?",
};

// Which clips each event may pick from. `sound(event)` rolls one at random,
// so she doesn't repeat herself on a busy day.
export const VOICE_EVENTS = {
  greet:     ['greet-1', 'greet-2', 'greet-3', 'greet-4'],
  connect:   ['connect-1', 'connect-2'],
  buy:       ['buy-1', 'buy-2', 'buy-3', 'buy-4'],
  profit:    ['profit-1', 'profit-2', 'profit-3', 'profit-4', 'profit-5'],
  bigProfit: ['bigprofit-1', 'bigprofit-2', 'bigprofit-3', 'bigprofit-4'],
  loss:      ['loss-1', 'loss-2', 'loss-3', 'loss-4', 'loss-5'],
  bigLoss:   ['bigloss-1', 'bigloss-2', 'bigloss-3'],
  flat:      ['flat-1', 'flat-2', 'flat-3'],
  grab:      ['grab-1', 'grab-2'],
  throw:     ['throw-1', 'throw-2'],
  land:      ['land-1', 'land-2'],
  dizzy:     ['dizzy-1', 'dizzy-2'],
  idle:      ['idle-1', 'idle-2', 'idle-3'],
  stretch:   ['stretch-1'],
  jump:      ['jump-1'],
  cheerUp:   ['cheerup-1', 'cheerup-2'],
};
