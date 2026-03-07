#!/bin/bash
# Build hnsd from source using MSYS2/MINGW64
#
# This script must be run from an MSYS2 MINGW64 shell, NOT Git Bash.
# Use build_hnsd.cmd to launch it from Windows.
#
# Prerequisites:
#   - MSYS2 installed at C:\msys64 (install via: choco install msys2 -y)
#   - Run this script from MSYS2 MINGW64 shell
#
# What it does:
#   1. Installs required packages (gcc, make, autotools, libunbound)
#   2. Clones hnsd repository (if not already cloned)
#   3. Builds hnsd.exe
#   4. Copies binary to ./bin/

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENDOR_DIR="$SCRIPT_DIR/vendor"
HNSD_DIR="$VENDOR_DIR/hnsd"
BIN_DIR="$SCRIPT_DIR/bin"
HNSD_REPO="https://github.com/handshake-org/hnsd.git"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Check we're in MSYS2 MINGW64 environment
check_environment() {
  if [ -z "$MSYSTEM" ]; then
    error "Not running in MSYS2 shell. Use build_hnsd.cmd or launch MSYS2 MINGW64 shell."
  fi
  if [ "$MSYSTEM" != "MINGW64" ]; then
    warn "MSYSTEM=$MSYSTEM (expected MINGW64). Build may not produce correct binaries."
  fi
  info "Environment: $MSYSTEM"
}

# Install required packages
install_packages() {
  info "Installing required packages..."
  pacman -S --noconfirm --needed \
    base-devel \
    mingw-w64-x86_64-toolchain \
    mingw-w64-x86_64-unbound \
    autoconf \
    automake \
    libtool \
    git
  info "Packages installed."
}

# Clone or update hnsd
clone_hnsd() {
  mkdir -p "$VENDOR_DIR"
  if [ -d "$HNSD_DIR/.git" ]; then
    info "hnsd already cloned, updating..."
    cd "$HNSD_DIR"
    git pull --ff-only || warn "Could not update hnsd (working on detached HEAD?)"
  else
    info "Cloning hnsd..."
    git clone "$HNSD_REPO" "$HNSD_DIR"
  fi
  cd "$HNSD_DIR"
  info "hnsd at commit: $(git rev-parse --short HEAD)"
}

# Build hnsd
build_hnsd() {
  cd "$HNSD_DIR"

  if [ ! -f configure ]; then
    info "Running autogen.sh..."
    ./autogen.sh
  fi

  if [ ! -f Makefile ]; then
    info "Running configure..."
    ./configure
  fi

  info "Building hnsd..."
  make -j$(nproc)

  if [ ! -f hnsd.exe ] && [ ! -f hnsd ]; then
    error "Build failed: hnsd binary not found"
  fi

  info "Build complete."
}

# Copy binary to bin/
install_binary() {
  mkdir -p "$BIN_DIR"
  if [ -f "$HNSD_DIR/hnsd.exe" ]; then
    cp "$HNSD_DIR/hnsd.exe" "$BIN_DIR/hnsd.exe"
  elif [ -f "$HNSD_DIR/hnsd" ]; then
    cp "$HNSD_DIR/hnsd" "$BIN_DIR/hnsd.exe"
  fi

  # Copy required DLLs
  local hnsd_deps
  hnsd_deps=$(ldd "$BIN_DIR/hnsd.exe" 2>/dev/null | grep mingw64 | awk '{print $3}' || true)
  if [ -n "$hnsd_deps" ]; then
    info "Copying required DLLs..."
    for dll in $hnsd_deps; do
      cp "$dll" "$BIN_DIR/" 2>/dev/null || true
    done
  fi

  info "Installed: $BIN_DIR/hnsd.exe"
  "$BIN_DIR/hnsd.exe" --help 2>&1 | head -5 || true
}

# Main
main() {
  info "=== hnsd Build Script ==="
  check_environment
  install_packages
  clone_hnsd
  build_hnsd
  install_binary
  info "=== Done ==="
  info "Binary: $BIN_DIR/hnsd.exe"
  info "Run: node check_hns.js sync"
}

main "$@"
