"""Regenerate frontend/src/lib/types.ts from the ```ts block in docs/API_CONTRACT.md."""
from pathlib import Path

root = Path(__file__).resolve().parents[1]
contract = (root / "docs" / "API_CONTRACT.md").read_text()
block = contract.split("```ts", 1)[1].split("```", 1)[0]
header = ("// Generated from docs/API_CONTRACT.md: the single source of truth for API shapes.\n"
          "// Regenerate (don't hand-edit) when the contract changes: `python3 scripts/gen_types.py`.\n/* eslint-disable */\n")
(root / "frontend" / "src" / "lib" / "types.ts").write_text(header + block.strip() + "\n")
print("wrote frontend/src/lib/types.ts")
