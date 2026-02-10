#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
# release.sh — Build, package, and optionally install VSIX
# ─────────────────────────────────────────────────────────
# Usage:
#   ./scripts/release.sh              # package current version
#   ./scripts/release.sh patch        # bump patch (2.0.0 → 2.0.1) then package
#   ./scripts/release.sh minor        # bump minor (2.0.0 → 2.1.0) then package
#   ./scripts/release.sh major        # bump major (2.0.0 → 3.0.0) then package
#   ./scripts/release.sh --install    # package + install into VS Code
#   ./scripts/release.sh patch --install  # bump + package + install
# ─────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BUMP=""
INSTALL=false

for arg in "$@"; do
  case "$arg" in
    patch|minor|major) BUMP="$arg" ;;
    --install|-i) INSTALL=true ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

# ── 1. Version bump (optional) ──
if [[ -n "$BUMP" ]]; then
  echo "📦 Bumping version ($BUMP)..."
  npm version "$BUMP" --no-git-tag-version
fi

VERSION=$(node -p "require('./package.json').version")
NAME=$(node -p "require('./package.json').name")
PUBLISHER=$(node -p "require('./package.json').publisher")
VSIX_FILE="${NAME}-${VERSION}.vsix"

echo ""
echo "══════════════════════════════════════════════"
echo "  Building: ${PUBLISHER}.${NAME} v${VERSION}"
echo "══════════════════════════════════════════════"
echo ""

# ── 2. Type check ──
echo "🔍 Type checking..."
npx tsc --noEmit
echo "   ✅ No type errors"

# ── 3. Run tests ──
echo "🧪 Running tests..."
npx mocha --require ts-node/register --ui tdd 'tests/unit/**/*.test.ts' --timeout 10000 2>&1 | tail -3
echo "   ✅ Tests passed"

# ── 4. Webpack production build ──
echo "📦 Webpack production build..."
npx webpack --mode production 2>&1 | tail -3
echo "   ✅ Build complete"

# ── 5. Package VSIX ──
echo "📦 Packaging VSIX..."
npx vsce package --no-dependencies --no-update-package-json
echo "   ✅ Created: ${VSIX_FILE}"

# ── 6. Show file size ──
SIZE=$(du -h "$VSIX_FILE" | cut -f1 | xargs)
echo ""
echo "══════════════════════════════════════════════"
echo "  ✅ ${VSIX_FILE} (${SIZE})"
echo "══════════════════════════════════════════════"

# ── 7. Install into VS Code (optional) ──
if $INSTALL; then
  echo ""
  echo "🚀 Installing into VS Code..."
  code --install-extension "$VSIX_FILE" --force
  echo "   ✅ Installed! Reload VS Code to activate."
fi

echo ""
echo "To install manually:"
echo "  1. VS Code → Cmd+Shift+P → 'Extensions: Install from VSIX...'"
echo "  2. Select: ${ROOT}/${VSIX_FILE}"
echo ""
echo "To update an existing install, just repeat — VS Code replaces in-place."
