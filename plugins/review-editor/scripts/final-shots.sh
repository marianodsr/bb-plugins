#!/bin/sh
# Final screenshot set for docs/screenshots/review-editor (run outside the sandbox).
set -e
cd "$(dirname "$0")/../../.."
OUT=docs/screenshots/review-editor
SCENE="node plugins/review-editor/scripts/scene.mjs --out $OUT"
MINE=proj_v2ia75srgp/thr_6c9qxw2hre
PRI=proj_u2r37p2sm2/thr_ewkdxytcsc
for T in light dark; do
  # Wide: the margin rail, the draft composer, the handoff sheet, the shortcut sheet.
  $SCENE --thread $MINE --theme $T --width 1920 --name editor-$T-wide --steps "review;wait:500;shot:review;open:end() should;wait:1500;click:button[aria-label^='Maximize']|;wait:1000;shot:rail;mouse:.rv-comment-marker@1;wait:700;shot:active;clickline:21;keys:Shift+ArrowDown,Shift+ArrowDown,Shift+End;wait:500;shot:selection;keys:Meta+Alt+KeyM;wait:700;type:Use a monotonic clock here;wait:300;shot:draft;keys:Escape;wait:400;mouse:.rv-editor header span;keys:s;wait:800;shot:handoff;keys:Escape;wait:300;keys:Shift+Slash;wait:700;shot:shortcuts;keys:Escape;close:session.ts"
  # 420 px side panel: folded notes and the Review tab.
  $SCENE --thread $MINE --theme $T --width 1160 --name editor-$T-420 --steps "review;wait:500;shot:review;open:end() should;wait:1500;mouse:.rv-comment-marker@1;wait:800;shot:folded;close:session.ts"
  # Diffs against real git history (read-only, HEAD~1 through the dev seam).
  $SCENE --thread $PRI --base-ref HEAD~1 --theme $T --width 1920 --name diff-$T-wide --steps "review;open:Temporary test;wait:1800;click:button[aria-label^='Maximize']|;wait:1000;shot:bars;mouse:.rv-bar-modified;wait:700;shot:peek;mouse:.rv-editor header span;keys:d;wait:900;shot:unified;keys:u;wait:1500;shot:split;keys:e;close:db.py"
  $SCENE --thread $PRI --base-ref HEAD~1 --theme $T --width 1160 --name diff-$T-420 --steps "review;open:Temporary test;wait:1800;mouse:.rv-editor header span;keys:d;wait:900;shot:unified;close:db.py"
done
# The palette command and reduced motion.
$SCENE --thread $MINE --width 1920 --name palette --steps "tab:New tab;mouse:#thread-detail-secondary-panel;keys:Meta+Shift+KeyP;wait:700;type:Review Editor;wait:800;shot:search;keys:Enter;wait:1500;shot:result"
$SCENE --thread $MINE --width 1920 --reduced-motion --name reduced --steps "review;open:end() should;wait:1500;click:button[aria-label^='Maximize']|;wait:900;mouse:.rv-editor header span;keys:BracketRight,BracketRight;wait:300;shot:walk;close:session.ts"
