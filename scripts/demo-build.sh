#!/usr/bin/env bash
# Buduje kartę demo krok po kroku i eksportuje PNG po każdym kroku (out/demo/NN.png).
# Każda klatka = realny render z Figmy. Wymaga: serwer mostka + plugin w Figmie.
set -euo pipefail
cd "$(dirname "$0")/.."

CLI=./bin/figma

id_of() { python3 -c "import json,sys; print(json.load(sys.stdin)['results'][0]['value']['id'])"; }

if [ "${1:-}" = "--keep" ]; then
  CARD=""
else
  mkdir -p out/demo
  rm -f out/demo/*.png
  # usuń poprzednią kartę demo, jeśli została
  $CLI op '{"op":"exec","code":"const olds = []; for (const p of figma.root.children) { for (const n of p.children) { if (n.name === \"Bridge / Demo\") { olds.push(n.id); n.remove() } } } return olds"}' >/dev/null
fi

echo "→ createFrame"
CARD=$($CLI run '[{"op":"createFrame","name":"Bridge / Demo","x":0,"y":900,"width":380,"height":240,"fill":"#0E0E12","props":{"cornerRadius":20,"layoutMode":"VERTICAL","paddingTop":24,"paddingRight":24,"paddingBottom":24,"paddingLeft":24,"itemSpacing":14,"primaryAxisSizingMode":"FIXED","counterAxisSizingMode":"FIXED"}}]' | id_of)
$CLI export "$CARD" out/demo/01.png PNG 2

echo "→ createText (title)"
$CLI run "[{\"op\":\"createText\",\"parentId\":\"$CARD\",\"name\":\"Title\",\"characters\":\"Bridge Demo\",\"fontFamily\":\"Inter\",\"fontStyle\":\"Semi Bold\",\"fontSize\":24,\"color\":\"#F2F2F7\"}]" >/dev/null
$CLI export "$CARD" out/demo/02.png PNG 2

echo "→ createText (subtitle)"
$CLI run "[{\"op\":\"createText\",\"parentId\":\"$CARD\",\"name\":\"Subtitle\",\"characters\":\"Built by an agent — no OAuth, no tokens\",\"fontSize\":13,\"color\":\"#8A8A94\"}]" >/dev/null
$CLI export "$CARD" out/demo/03.png PNG 2

echo "→ createFrame (CTA) + label"
CTA=$($CLI run "[{\"op\":\"createFrame\",\"parentId\":\"$CARD\",\"name\":\"CTA\",\"width\":108,\"height\":36,\"fill\":\"#6E56CF\",\"props\":{\"cornerRadius\":18,\"layoutMode\":\"HORIZONTAL\",\"primaryAxisAlignItems\":\"CENTER\",\"counterAxisAlignItems\":\"CENTER\",\"primaryAxisSizingMode\":\"FIXED\",\"counterAxisSizingMode\":\"FIXED\"}}]" | id_of)
$CLI run "[{\"op\":\"createText\",\"parentId\":\"$CTA\",\"name\":\"CTA label\",\"characters\":\"View\",\"fontFamily\":\"Inter\",\"fontStyle\":\"Medium\",\"fontSize\":13,\"color\":\"#FFFFFF\"}]" >/dev/null
$CLI export "$CARD" out/demo/04.png PNG 2

echo "→ createFrame (tags)"
ROW=$($CLI run "[{\"op\":\"createFrame\",\"parentId\":\"$CARD\",\"name\":\"Tags\",\"width\":200,\"height\":30,\"fill\":null,\"props\":{\"layoutMode\":\"HORIZONTAL\",\"itemSpacing\":8,\"primaryAxisSizingMode\":\"AUTO\",\"counterAxisSizingMode\":\"AUTO\"}}]" | id_of)
read -r T1 T2 <<< "$(python3 - "$CLI" "$ROW" <<'PY'
import json, subprocess, sys
cli, row = sys.argv[1], sys.argv[2]
def tag():
    ops = [{"op":"createFrame","parentId":row,"name":"Tag","width":88,"height":30,"fill":"#1A1A21",
            "props":{"cornerRadius":15,"layoutMode":"HORIZONTAL","primaryAxisAlignItems":"CENTER",
                     "counterAxisAlignItems":"CENTER","primaryAxisSizingMode":"FIXED","counterAxisSizingMode":"FIXED"}}]
    out = subprocess.run([cli, "run", json.dumps(ops)], capture_output=True, text=True, check=True).stdout
    return json.loads(out)["results"][0]["value"]["id"]
print(tag(), tag())
PY
)"
$CLI run "[{\"op\":\"createText\",\"parentId\":\"$T1\",\"characters\":\"Design\",\"fontSize\":11,\"color\":\"#C9C9D2\"},{\"op\":\"createText\",\"parentId\":\"$T2\",\"characters\":\"Motion\",\"fontSize\":11,\"color\":\"#C9C9D2\"}]" >/dev/null
$CLI export "$CARD" out/demo/05.png PNG 2

echo "→ update (hover state)"
$CLI run "[{\"op\":\"update\",\"nodeId\":\"$CTA\",\"props\":{\"fills\":[\"#8B76FF\"]}},{\"op\":\"update\",\"nodeId\":\"$CARD\",\"props\":{\"strokes\":[\"#26262E\"],\"strokeWeight\":1}}]" >/dev/null
$CLI export "$CARD" out/demo/06.png PNG 2

echo "gotowe: out/demo/*.png (6 klatek), karta $CARD"
